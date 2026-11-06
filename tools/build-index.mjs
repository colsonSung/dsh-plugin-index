#!/usr/bin/env node
/**
 * Build the DSH plugin market index (format 1) from `catalog.json`.
 *
 * For every plugin in the catalog this resolves the repository's HEAD commit, reads the real
 * `package.json` at that commit, and emits an index entry whose install target is pinned to that
 * commit. The package name in `catalog.json` must match the name in the repository's
 * `package.json`; a mismatch aborts the build, because it means the catalog points at the wrong
 * repository.
 *
 * Usage: node tools/build-index.mjs [--out index.json] [--catalog catalog.json]
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'

const execFileAsync = promisify(execFile)

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const USER_AGENT = 'dsh-plugin-index-builder'
/** Largest decoded payload of an inline `data:` icon, in bytes (matches the official validator). */
const MAX_ICON_BYTES = 32 * 1024
/** Brand colour of the generated letter mark. */
const BRAND = '#635BFF'
const COMMIT_SHA = /^[0-9a-f]{40}$/
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/
const ICON_MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  process.stdout.write(
    'Usage: node tools/build-index.mjs [--out <index.json>] [--catalog <catalog.json>] [--overrides <overrides.json>]\n' +
      '  --out       output path of the generated index (default: <repo root>/index.json)\n' +
      '  --catalog   path of the plugin catalog (default: <repo root>/catalog.json)\n' +
      '  --overrides path of the per-repository overrides (default: overrides.json beside the catalog)\n',
  )
}

function parseArgs(argv) {
  const options = {
    out: path.join(REPO_ROOT, 'index.json'),
    catalog: path.join(REPO_ROOT, 'catalog.json'),
    overrides: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--out' || argument === '--catalog' || argument === '--overrides') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${argument} needs a value`)
      options[argument.slice(2)] = path.resolve(process.cwd(), value)
      index += 1
    } else if (argument.startsWith('--out=')) {
      options.out = path.resolve(process.cwd(), argument.slice('--out='.length))
    } else if (argument.startsWith('--catalog=')) {
      options.catalog = path.resolve(process.cwd(), argument.slice('--catalog='.length))
    } else if (argument.startsWith('--overrides=')) {
      options.overrides = path.resolve(process.cwd(), argument.slice('--overrides='.length))
    } else if (argument === '--help' || argument === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (options.overrides === null) {
    options.overrides = path.join(path.dirname(options.catalog), 'overrides.json')
  }
  return options
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const warnings = []
/** Plugins dropped by an overrides entry, reported at the end of the build. */
const excluded = []

function warn(message) {
  warnings.push(message)
  process.stderr.write(`WARN  ${message}\n`)
}

function info(message) {
  process.stdout.write(`${message}\n`)
}

// ---------------------------------------------------------------------------
// GitHub access
// ---------------------------------------------------------------------------

let cachedToken

/** Read a GitHub token from the environment or the `gh` keyring. It never reaches the disk. */
async function githubToken() {
  if (cachedToken !== undefined) return cachedToken
  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN
    return cachedToken
  }
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { encoding: 'utf8' })
    cachedToken = stdout.trim() || null
  } catch {
    cachedToken = null
  }
  return cachedToken
}

async function fetchWithHeaders(url, headers) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } })
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`)
  }
  return response
}

async function fetchApiJson(url) {
  const headers = { Accept: 'application/vnd.github+json' }
  const token = await githubToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetchWithHeaders(url, headers)
  return response.json()
}

/** Read one commit through the `gh` CLI. Returns null when the CLI cannot answer. */
async function tryGhApi(route) {
  try {
    const { stdout } = await execFileAsync('gh', ['api', route], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

/**
 * Resolve a git ref (default `HEAD`) to a commit: its 40-hex SHA and its committer date.
 * Prefers the `gh` CLI, then falls back to the REST API with a bearer token.
 */
async function resolveCommit(repo, ref = 'HEAD') {
  const fromCli = await tryGhApi(`repos/${repo}/commits/${ref}`)
  const payload =
    fromCli ?? (await fetchApiJson(`${GITHUB_API}/repos/${repo}/commits/${ref}`))
  const sha = payload?.sha
  if (typeof sha !== 'string' || !COMMIT_SHA.test(sha)) {
    throw new Error(`GitHub returned an unusable commit SHA for ${repo}@${ref}: ${JSON.stringify(sha)}`)
  }
  const date = payload?.commit?.committer?.date
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) {
    throw new Error(`GitHub returned no committer date for ${repo}@${ref}`)
  }
  return { sha, date }
}

/** Read the `package.json` of one repository directory at one commit. */
async function readManifest(repo, commit, directory) {
  const relative = directory ? `${directory}/package.json` : 'package.json'
  const url = `${GITHUB_RAW}/${repo}/${commit}/${relative}`
  const response = await fetchWithHeaders(url, {})
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${url} is not valid JSON`)
  }
}

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

/**
 * The publish time of one npm version, in Unix seconds.
 * The registry's packument is the primary source; `npm view` is the fallback.
 */
async function npmPublishTime(packageName, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
  try {
    const response = await fetchWithHeaders(url, { Accept: 'application/json' })
    const payload = await response.json()
    const stamp = payload?.time?.[version]
    if (typeof stamp === 'string') return Math.floor(Date.parse(stamp) / 1000)
    throw new Error(`the registry lists no publish time for ${packageName}@${version}`)
  } catch (error) {
    try {
      const { stdout } = await execFileAsync('npm', ['view', packageName, 'time', '--json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      const payload = JSON.parse(stdout)
      const stamp = payload?.[version]
      if (typeof stamp !== 'string') throw new Error(`no publish time for ${packageName}@${version}`)
      return Math.floor(Date.parse(stamp) / 1000)
    } catch {
      throw new Error(`cannot read the publish time of ${packageName}@${version}: ${error.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/** Read the optional overrides file. A missing file simply means "no overrides". */
async function readOverrides(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`cannot read the overrides file ${filePath}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} must hold an object keyed by "owner/repo"`)
  }
  return parsed
}

/** The override that applies to one repository, if any. */
function overrideFor(overrides, repo) {
  const entry = overrides[repo]
  return typeof entry === 'object' && entry !== null ? entry : undefined
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function dataUrl(bytes, mime) {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * The letter shown by the generated mark. A scoped package name starts with `@`, which is not a
 * letter, so the scope is dropped and the package's own name supplies the letter.
 */
function letterFor(packageName) {
  const unscoped = packageName.startsWith('@')
    ? packageName.slice(packageName.indexOf('/') + 1)
    : packageName
  const match = unscoped.match(/[A-Za-z0-9]/)
  return (match ? match[0] : 'D').toUpperCase()
}

/** A 64x64 rounded square in the brand colour with one white letter. */
function letterMark(letter) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${letter}">` +
    `<rect width="64" height="64" rx="14" fill="${BRAND}"/>` +
    `<text x="32" y="34" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" ` +
    `font-size="32" font-weight="600" text-anchor="middle" dominant-baseline="central">${letter}</text>` +
    `</svg>\n`
  )
}

/**
 * Resolve the icon of one plugin into an inline `data:` URL.
 * Returns undefined when the icon must be left out of the index.
 */
async function resolveIcon(catalogPlugin, packageName, repo, commit) {
  const requested = catalogPlugin.icon
  if (requested === null || requested === undefined || requested === '') {
    return dataUrl(Buffer.from(letterMark(letterFor(packageName)), 'utf8'), 'image/svg+xml')
  }
  if (typeof requested !== 'string') {
    warn(`${repo}: icon must be a string path or null, got ${typeof requested}; icon omitted`)
    return undefined
  }
  const mime = ICON_MIME[path.extname(requested).toLowerCase()]
  if (!mime) {
    warn(`${repo}: unsupported icon type for "${requested}"; icon omitted`)
    return undefined
  }
  const url = `${GITHUB_RAW}/${repo}/${commit}/${requested}`
  let bytes
  try {
    const response = await fetchWithHeaders(url, {})
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    warn(`${repo}: cannot read icon "${requested}" (${error.message}); icon omitted`)
    return undefined
  }
  if (bytes.length > MAX_ICON_BYTES) {
    warn(
      `${repo}: icon "${requested}" decodes to ${bytes.length} bytes, over the ${MAX_ICON_BYTES} byte limit; icon omitted`,
    )
    return undefined
  }
  if (mime === 'image/svg+xml' && !/<svg[\s>]/i.test(bytes.toString('utf8'))) {
    warn(`${repo}: icon "${requested}" is not an SVG document; icon omitted`)
    return undefined
  }
  return dataUrl(bytes, mime)
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

/** Drop undefined members so the validator sees them as absent, not as empty values. */
function compact(object) {
  const result = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/** Check the shape of a localized text and fail with a readable message. */
function checkLocalized(value, label) {
  if (typeof value === 'string') {
    if (value.trim() === '') throw new Error(`${label} must not be blank`)
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object of language ids`)
  }
  if (!Object.hasOwn(value, 'en')) throw new Error(`${label} must contain "en"`)
  for (const language of Object.keys(value)) {
    if (!LANGUAGE_ID.test(language)) {
      throw new Error(`${label}.${language} is not a lowercase language id`)
    }
  }
}

function checkCatalog(catalog) {
  if (typeof catalog !== 'object' || catalog === null) throw new Error('catalog must be an object')
  if (typeof catalog.index !== 'object' || catalog.index === null) {
    throw new Error('catalog.index is missing')
  }
  if (!Array.isArray(catalog.plugins)) throw new Error('catalog.plugins must be an array')
  checkLocalized(catalog.index.title, 'catalog.index.title')
  if (catalog.index.description !== undefined) {
    checkLocalized(catalog.index.description, 'catalog.index.description')
  }
  for (const [group, member] of Object.entries(catalog.index.categories ?? {})) {
    checkLocalized(member?.title, `catalog.index.categories.${group}.title`)
  }
  for (const [group, member] of Object.entries(catalog.index.labels ?? {})) {
    checkLocalized(member?.title, `catalog.index.labels.${group}.title`)
  }
  for (const [group, member] of Object.entries(catalog.index.sortKeys ?? {})) {
    checkLocalized(member?.title, `catalog.index.sortKeys.${group}.title`)
    if (member?.order !== 'asc' && member?.order !== 'desc') {
      throw new Error(`catalog.index.sortKeys.${group}.order must be "asc" or "desc"`)
    }
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** Build one version entry of one plugin. */
async function buildVersion(plugin, entry) {
  const repo = entry.repo ?? plugin.repo
  const directory = entry.directory ?? plugin.directory ?? ''
  const commit = await resolveCommit(repo, entry.commit ?? 'HEAD')
  const manifest = await readManifest(repo, commit.sha, directory)

  if (manifest.name !== plugin.packageName) {
    throw new Error(
      `catalog packageName "${plugin.packageName}" does not match the package name "${manifest.name}" ` +
        `in ${repo}@${commit.sha}${directory ? `/${directory}` : ''} — the catalog points at the wrong repository`,
    )
  }

  const version = entry.version ?? manifest.version
  if (entry.version !== undefined && manifest.version !== undefined && entry.version !== manifest.version) {
    warn(
      `${repo}: catalog pins version ${entry.version} but package.json at ${commit.sha} says ${manifest.version}; ` +
        `the catalog version wins`,
    )
  }

  const url = `https://github.com/${repo}`
  const engines = {}
  const dshRange = manifest.engines?.dsh
  if (typeof dshRange === 'string' && dshRange.trim() !== '') {
    if (dshRange.startsWith('workspace:')) {
      warn(`${repo}: engines.dsh is a workspace range and cannot be published; engines omitted`)
    } else {
      engines.dsh = dshRange
    }
  }

  return {
    version,
    publishTimestamp: Math.floor(Date.parse(commit.date) / 1000),
    source: compact({
      type: 'git',
      url,
      commit: commit.sha,
      path: directory === '' ? undefined : directory,
    }),
    ...(Object.keys(engines).length > 0 ? { engines } : {}),
  }
}

/** Build one plugin entry of the index. Returns null when the plugin is excluded. */
async function buildPlugin(plugin, override) {
  if (typeof plugin.repo !== 'string' || !REPO_SLUG.test(plugin.repo)) {
    throw new Error(`repo must look like "owner/name", got ${JSON.stringify(plugin.repo)}`)
  }
  if (typeof plugin.packageName !== 'string' || plugin.packageName.trim() === '') {
    throw new Error(`packageName is missing for ${plugin.repo}`)
  }
  const directory = plugin.directory ?? ''
  if (directory !== '' && !/^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(directory)) {
    throw new Error(`directory ${JSON.stringify(directory)} of ${plugin.repo} is not a relative POSIX path`)
  }

  if (override?.exclude === true) {
    excluded.push({ repo: plugin.repo, reason: override.reason ?? 'no reason given' })
    return null
  }

  const head = await resolveCommit(plugin.repo, 'HEAD')
  const headManifest = await readManifest(plugin.repo, head.sha, directory)
  if (headManifest.name !== plugin.packageName) {
    throw new Error(
      `catalog packageName "${plugin.packageName}" does not match the package name "${headManifest.name}" ` +
        `in ${plugin.repo}@${head.sha}${directory ? `/${directory}` : ''} — the catalog points at the wrong repository`,
    )
  }

  const versions = []
  if (override?.npm) {
    if (Array.isArray(plugin.versions) && plugin.versions.length > 0) {
      warn(`${plugin.repo}: the npm override replaces the ${plugin.versions.length} catalog version(s)`)
    }
    const npmName = override.npm.name ?? plugin.packageName
    const npmVersion = override.npm.version
    if (typeof npmVersion !== 'string' || npmVersion.trim() === '') {
      throw new Error(`${plugin.repo}: the npm override needs a version`)
    }
    const publishTimestamp = await npmPublishTime(npmName, npmVersion)
    versions.push({
      version: npmVersion,
      publishTimestamp,
      // No registry member on purpose: the installing client asks its own registry.
      source: { type: 'npm' },
    })
  } else if (Array.isArray(plugin.versions) && plugin.versions.length > 0) {
    for (const entry of plugin.versions) {
      versions.push(await buildVersion(plugin, entry))
    }
  } else {
    versions.push({
      version: headManifest.version,
      publishTimestamp: Math.floor(Date.parse(head.date) / 1000),
      source: compact({
        type: 'git',
        url: `https://github.com/${plugin.repo}`,
        commit: head.sha,
        path: directory === '' ? undefined : directory,
      }),
      ...(typeof headManifest.engines?.dsh === 'string' && !headManifest.engines.dsh.startsWith('workspace:')
        ? { engines: { dsh: headManifest.engines.dsh } }
        : {}),
    })
  }

  const icon = await resolveIcon(plugin, plugin.packageName, plugin.repo, head.sha)

  return compact({
    name: plugin.packageName,
    title: plugin.title,
    description: plugin.description,
    icon,
    author: plugin.author,
    homepage: plugin.homepage ?? `https://github.com/${plugin.repo}`,
    repository: compact({
      url: `https://github.com/${plugin.repo}`,
      directory: directory === '' ? undefined : directory,
    }),
    metadata: compact({
      category: plugin.category,
      keywords: plugin.keywords ?? [],
      labels: plugin.labels ?? [],
      sortKeys: plugin.sortKeys ?? {},
    }),
    versions,
  })
}

/** Run `task` over `items` with a bounded number of concurrent workers. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2))

  let catalogText
  try {
    catalogText = await readFile(options.catalog, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stderr.write(
        `ERROR  catalog not found: ${options.catalog}\n` +
          `        Write the plugin catalog first, or point at another file with --catalog <path>.\n`,
      )
      process.exit(1)
    }
    throw error
  }

  let catalog
  try {
    catalog = JSON.parse(catalogText)
  } catch (error) {
    process.stderr.write(`ERROR  ${options.catalog} is not valid JSON: ${error.message}\n`)
    process.exit(1)
  }

  try {
    checkCatalog(catalog)
  } catch (error) {
    process.stderr.write(`ERROR  ${error.message}\n`)
    process.exit(1)
  }

  const failures = []
  const overrides = await readOverrides(options.overrides)
  const plugins = await mapLimit(catalog.plugins, 4, async (plugin) => {
    try {
      const built = await buildPlugin(plugin, overrideFor(overrides, plugin.repo))
      if (built === null) return undefined
      info(`  built  ${built.name}@${built.versions.map((version) => version.version).join(', ')}`)
      return built
    } catch (error) {
      failures.push(`${plugin.repo ?? plugin.packageName ?? 'unknown plugin'}: ${error.message}`)
      return undefined
    }
  })

  if (failures.length > 0) {
    process.stderr.write(`\nERROR  ${failures.length} plugin(s) failed to build:\n`)
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
    process.stderr.write('        index.json was not written.\n')
    process.exit(1)
  }

  const index = {
    format: 1,
    title: catalog.index.title,
    ...(catalog.index.description !== undefined ? { description: catalog.index.description } : {}),
    metadata: {
      categories: catalog.index.categories ?? {},
      labels: catalog.index.labels ?? {},
      sortKeys: catalog.index.sortKeys ?? {},
    },
    plugins: plugins.filter(Boolean),
  }

  await writeFile(options.out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

  info(`\n收录插件 ${index.plugins.length} 个（共 ${catalog.plugins.length} 个候选）`)
  for (const entry of excluded) {
    info(`已排除 ${entry.repo}：${entry.reason}`)
  }
  info('\n安装目标：')
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      const target = marketInstallTarget(plugin.name, version)
      info(`  ${plugin.name}@${version.version}  source=${version.source.type}  install=${target.spec}`)
    }
  }
  info(
    `\nWrote ${options.out}\n` +
      `  plugins: ${index.plugins.length}\n` +
      `  versions: ${index.plugins.reduce((total, plugin) => total + plugin.versions.length, 0)}\n` +
      `  excluded: ${excluded.length}\n` +
      `  warnings: ${warnings.length}`,
  )
}

main().catch((error) => {
  process.stderr.write(`ERROR  ${error?.stack ?? error}\n`)
  process.exit(1)
})

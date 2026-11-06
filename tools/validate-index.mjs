#!/usr/bin/env node
/**
 * Validate the generated plugin market index with the official validator, print the install
 * target of every version, and check that every install source is reachable.
 *
 * Usage: node tools/validate-index.mjs [--index index.json] [--index-url <url>]
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MarketIndexError, parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'

const execFileAsync = promisify(execFile)

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

const DEFAULT_INDEX_URL = 'https://colsonsung.github.io/dsh-plugin-index/index.json'
const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const USER_AGENT = 'dsh-plugin-index-validator'

function printUsage() {
  process.stdout.write(
    'Usage: node tools/validate-index.mjs [--index <index.json>] [--index-url <url>]\n' +
      '  --index     path of the index to validate (default: <repo root>/index.json)\n' +
      '  --index-url the URL the index is published at; relative icon references resolve against it\n',
  )
}

function parseArgs(argv) {
  const options = {
    index: path.join(REPO_ROOT, 'index.json'),
    indexUrl: DEFAULT_INDEX_URL,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--index' || argument === '--index-url') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${argument} needs a value`)
      if (argument === '--index') options.index = path.resolve(process.cwd(), value)
      else options.indexUrl = value
      index += 1
    } else if (argument.startsWith('--index=')) {
      options.index = path.resolve(process.cwd(), argument.slice('--index='.length))
    } else if (argument.startsWith('--index-url=')) {
      options.indexUrl = argument.slice('--index-url='.length)
    } else if (argument === '--help' || argument === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
}

let cachedToken

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

async function head(url, headers = {}) {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, ...headers },
  })
  return response
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return response.json()
}

/** Confirm that the repository and the pinned commit exist, and that the package sits there. */
async function checkGitSource(source) {
  const { url, commit } = source
  const segments = new URL(url).pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    return [`${url} does not name an owner and a repository`]
  }
  const [owner, repository] = segments
  const problems = []

  const headers = {}
  const token = await githubToken()
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const commitPayload = await getJson(`${GITHUB_API}/repos/${owner}/${repository}/commits/${commit}`, headers)
    if (commitPayload?.sha !== commit) {
      problems.push(`${owner}/${repository} resolved the commit to ${commitPayload?.sha}, expected ${commit}`)
    }
  } catch (error) {
    problems.push(`cannot reach ${owner}/${repository}@${commit}: ${error.message}`)
  }

  const relative = source.path ? `${source.path}/package.json` : 'package.json'
  try {
    const response = await head(`${GITHUB_RAW}/${owner}/${repository}/${commit}/${relative}`)
    if (!response.ok) {
      problems.push(`${relative} is missing at ${owner}/${repository}@${commit} (HTTP ${response.status})`)
    }
  } catch (error) {
    problems.push(`cannot read ${relative} at ${owner}/${repository}@${commit}: ${error.message}`)
  }

  return problems
}

/** Confirm that the pinned version exists on the npm registry. */
async function checkNpmSource(name, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  try {
    const payload = await getJson(url)
    if (payload?.version !== version) {
      return [`the registry reports version ${payload?.version} for ${name}@${version}`]
    }
    return []
  } catch (error) {
    return [`cannot reach ${name}@${version} on the npm registry: ${error.message}`]
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  let text
  try {
    text = await readFile(options.index, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stderr.write(
        `ERROR  index not found: ${options.index}\n` +
          `        Run "npm run build" first, or point at another file with --index <path>.\n`,
      )
      process.exit(1)
    }
    throw error
  }

  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    process.stderr.write(`ERROR  ${options.index} is not valid JSON: ${error.message}\n`)
    process.exit(1)
  }

  // The official validator is the only standard: it decides whether the index is publishable.
  let index
  try {
    index = parseMarketIndex(value, options.indexUrl)
  } catch (error) {
    if (error instanceof MarketIndexError) {
      process.stderr.write(`ERROR  the index violates the market index format\n`)
      process.stderr.write(`        path:   ${error.path}\n`)
      process.stderr.write(`        reason: ${error.reason}\n`)
      process.exit(1)
    }
    throw error
  }

  process.stdout.write(`OK    ${options.index} passes the market index format 1 validator\n`)
  process.stdout.write(`      index url: ${options.indexUrl}\n`)
  process.stdout.write(`      plugins:   ${index.plugins.length}\n`)
  process.stdout.write(
    `      versions:  ${index.plugins.reduce((total, plugin) => total + plugin.versions.length, 0)}\n\n`,
  )

  process.stdout.write('安装目标：\n')
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      const target = marketInstallTarget(plugin.name, version)
      const registry = target.registry ? ` registry=${target.registry}` : ''
      process.stdout.write(`  ${plugin.name}@${version.version}  ${target.spec}${registry}\n`)
    }
  }

  process.stdout.write('\n远端可达性：\n')
  let warnings = 0
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      const problems =
        version.source.type === 'npm'
          ? await checkNpmSource(plugin.name, version.version)
          : await checkGitSource(version.source)
      if (problems.length === 0) {
        process.stdout.write(`  OK    ${plugin.name}@${version.version}\n`)
      } else {
        warnings += problems.length
        for (const problem of problems) {
          process.stdout.write(`  WARN  ${plugin.name}@${version.version}: ${problem}\n`)
        }
      }
    }
  }

  process.stdout.write(
    `\n${warnings === 0 ? '全部通过' : `完成，但有 ${warnings} 条告警`}：` +
      `${index.plugins.length} 个插件，` +
      `${index.plugins.reduce((total, plugin) => total + plugin.versions.length, 0)} 个版本\n`,
  )
  // The validator decides the exit code; reachability problems are warnings, not failures.
  process.exit(0)
}

main().catch((error) => {
  process.stderr.write(`ERROR  ${error?.stack ?? error}\n`)
  process.exit(1)
})

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertStrategyHistoricalDataset } from './historical-dataset'
import { fetchOkxHistoricalDataset } from './okx-historical'

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function timestamp(value: unknown, name: string) {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  throw new Error(`${name} must be an integer timestamp or ISO date`)
}

async function writeJsonAtomic(file: string, value: unknown) {
  const destination = resolve(file)
  const temporary = `${destination}.tmp.${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, destination)
  return destination
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== '--')
  const action = args[0]
  const params = record(JSON.parse(args[1] || '{}'), 'params')
  if (action === 'fetch-okx') {
    if (!Array.isArray(params.timeframes) || params.timeframes.length === 0) {
      throw new Error('params.timeframes must be a non-empty array')
    }
    const dataset = await fetchOkxHistoricalDataset({
      instrumentId: text(params.instrumentId, 'params.instrumentId'),
      symbol: text(params.symbol, 'params.symbol'),
      timeframes: params.timeframes.map((value, index) => text(value, `params.timeframes[${index}]`)),
      startTime: timestamp(params.start, 'params.start'),
      endTime: timestamp(params.end, 'params.end'),
    })
    const output = await writeJsonAtomic(text(params.output, 'params.output'), dataset)
    return {
      ok: true,
      output,
      datasetHash: dataset.datasetHash,
      capturedThrough: dataset.capturedThrough,
      candles: Object.fromEntries(Object.entries(dataset.timeframes).map(([key, value]) => [key, value.length])),
    }
  }
  if (action === 'verify') {
    const file = resolve(text(params.input, 'params.input'))
    const dataset = assertStrategyHistoricalDataset(JSON.parse(await readFile(file, 'utf8')))
    return {
      ok: true,
      input: file,
      datasetHash: dataset.datasetHash,
      capturedThrough: dataset.capturedThrough,
      candles: Object.fromEntries(Object.entries(dataset.timeframes).map(([key, value]) => [key, value.length])),
    }
  }
  throw new Error('Usage: history-cli.ts <fetch-okx|verify> <json-params>')
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })

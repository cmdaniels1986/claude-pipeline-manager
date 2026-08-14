import { createServer, type Server } from 'http'
import type { TermUsage } from '../../shared/types'
import { estimateCost } from './pricing'

/**
 * Receives Claude Code OpenTelemetry metrics (OTLP/JSON) on a local port and
 * accumulates real per-session token usage and cost. Each spawned session is
 * launched with --session-id=<termId> and OTEL env pointing here, so the
 * metric attribute session.id === termId. Cumulative counters → latest value
 * per (session, type) wins.
 */
interface SourceAgg {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}
interface SessionUsage {
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number | null
  lastTurnTokens: number
  /** per-source subtotals when the CLI tags token.usage with query_source /
   *  mcp_server.name; stays empty on builds that don't emit those attributes */
  bySource: Map<string, SourceAgg>
}

interface OtlpValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
}
interface OtlpDataPoint {
  attributes?: { key: string; value: OtlpValue }[]
  asInt?: string | number
  asDouble?: number
}
interface OtlpMetric {
  name: string
  // aggregationTemporality: 1 = DELTA (Claude Code's default), 2 = CUMULATIVE
  sum?: { dataPoints?: OtlpDataPoint[]; aggregationTemporality?: number }
  gauge?: { dataPoints?: OtlpDataPoint[] }
}
interface OtlpBody {
  resourceMetrics?: { scopeMetrics?: { metrics?: OtlpMetric[] }[] }[]
}

export class UsageTracker {
  private http: Server | null = null
  private tracked = new Set<string>()
  private sessions = new Map<string, SessionUsage>()
  port = 0

  constructor(private onUsage: (usage: TermUsage) => void) {}

  async start(): Promise<number> {
    this.http = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.includes('/v1/metrics')) {
        res.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        try {
          this.ingest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpBody)
        } catch {
          // malformed batch — ignore
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
    })
    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    const addr = this.http.address()
    if (addr && typeof addr === 'object') this.port = addr.port
    return this.port
  }

  /** OTEL env for a spawned session so its metrics land here, tagged with session.id */
  envFor(): Record<string, string> {
    return {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${this.port}`,
      OTEL_METRIC_EXPORT_INTERVAL: '10000'
    }
  }

  track(termId: string): void {
    this.tracked.add(termId)
  }

  untrack(termId: string): void {
    this.tracked.delete(termId)
    this.sessions.delete(termId)
  }

  dispose(): void {
    this.http?.close()
    this.http = null
    this.tracked.clear()
    this.sessions.clear()
  }

  private ingest(body: OtlpBody): void {
    const touched = new Set<string>()
    for (const rm of body.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          const dps = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? []
          // Claude Code exports DELTA counters (each batch = usage since the last
          // export), so accumulate. Guard for cumulative in case that ever changes.
          const cumulative = metric.sum?.aggregationTemporality === 2
          for (const dp of dps) {
            const sid = this.attr(dp, 'session.id')
            if (!sid || !this.tracked.has(sid)) continue
            const s = this.session(sid)
            const model = this.attr(dp, 'model')
            if (model) s.model = model
            const val = this.num(dp)
            if (metric.name === 'claude_code.cost.usage') {
              s.costUsd = cumulative ? val : (s.costUsd ?? 0) + val
              touched.add(sid)
            } else if (metric.name === 'claude_code.token.usage') {
              const type = this.attr(dp, 'type')
              const acc = (cur: number): number => (cumulative ? val : cur + val)
              if (type === 'input') s.input = acc(s.input)
              else if (type === 'output') s.output = acc(s.output)
              else if (type === 'cacheRead') s.cacheRead = acc(s.cacheRead)
              else if (type === 'cacheCreation') s.cacheCreation = acc(s.cacheCreation)
              // attribute the same point to its source, when the CLI tags it —
              // lets the advisor flag "a subagent/MCP server is N% of your tokens"
              const source = this.attr(dp, 'query_source') ?? this.attr(dp, 'mcp_server.name')
              if (source && type) {
                const bs = s.bySource.get(source) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
                if (type === 'input') bs.input = cumulative ? val : bs.input + val
                else if (type === 'output') bs.output = cumulative ? val : bs.output + val
                else if (type === 'cacheRead') bs.cacheRead = cumulative ? val : bs.cacheRead + val
                else if (type === 'cacheCreation') bs.cacheCreation = cumulative ? val : bs.cacheCreation + val
                s.bySource.set(source, bs)
              }
              touched.add(sid)
            }
          }
        }
      }
    }
    for (const sid of touched) this.emit(sid)
  }

  private session(sid: string): SessionUsage {
    let s = this.sessions.get(sid)
    if (!s) {
      s = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: null, lastTurnTokens: 0, bySource: new Map() }
      this.sessions.set(sid, s)
    }
    return s
  }

  private emit(sid: string): void {
    const s = this.sessions.get(sid)
    if (!s) return
    // telemetry cost is Claude Code's own figure; fall back to our estimate if absent
    const cost =
      s.costUsd ??
      estimateCost(s.model, {
        input: s.input,
        output: s.output,
        cacheCreation: s.cacheCreation,
        cacheRead: s.cacheRead
      })
    const bySource = s.bySource.size
      ? [...s.bySource.entries()].map(([source, v]) => ({ source, ...v }))
      : undefined
    this.onUsage({
      termId: sid,
      model: s.model,
      inputTokens: s.input,
      outputTokens: s.output,
      cacheCreationTokens: s.cacheCreation,
      cacheReadTokens: s.cacheRead,
      // OTEL usage is cumulative across the session; approximate current context
      // fullness as the input side of the running totals
      contextTokens: s.input + s.cacheRead + s.cacheCreation,
      messages: 0,
      costUsd: cost,
      bySource
    })
  }

  private attr(dp: OtlpDataPoint, key: string): string | undefined {
    const a = dp.attributes?.find((x) => x.key === key)
    return a?.value.stringValue ?? (a?.value.intValue != null ? String(a.value.intValue) : undefined)
  }

  private num(dp: OtlpDataPoint): number {
    if (dp.asInt != null) return typeof dp.asInt === 'string' ? parseInt(dp.asInt, 10) : dp.asInt
    if (dp.asDouble != null) return dp.asDouble
    return 0
  }
}

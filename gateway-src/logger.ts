import pino from 'pino'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
let hasPinoPretty = false
try {
  require.resolve('pino-pretty')
  hasPinoPretty = true
} catch {
  // pino-pretty not installed (e.g. in production Docker build)
}

export function createLogger(level: string, nodeEnv: string) {
  return pino({
    level,
    ...(nodeEnv === 'development' && hasPinoPretty && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l' },
      },
    }),
  })
}


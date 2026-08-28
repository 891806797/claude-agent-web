import { OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from './types'

/**
 * 模块 app 的唯一合法构造方式 —— 禁止在业务代码中 `new OpenAPIHono()`。
 * 工厂统一注入：
 *   1. defaultHook：zod 校验失败集中转为 422 统一错误体（官方机制）
 *   2. AppEnv 泛型：c.get('traceId') / c.get('logger') 的类型来源
 */
export function createApp(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (result.success) {
        return
      }
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: '请求参数校验失败',
            traceId: c.get('traceId'),
            details: z.treeifyError(result.error),
          },
        },
        422,
      )
    },
  })
}

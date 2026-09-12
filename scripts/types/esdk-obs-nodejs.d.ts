/**
 * esdk-obs-nodejs 最小类型声明（包未自带 .d.ts）—— 仅声明 publish-obs.ts 用到的
 * ObsClient 构造与 putObject。CJS module.exports 为构造函数；ESM 默认导入拿到该函数。
 */
declare module 'esdk-obs-nodejs' {
  export interface ObsClientOptions {
    access_key_id: string
    secret_access_key: string
    server: string
    max_connections?: number
    timeout?: number
  }

  export interface ObsResult {
    CommonMsg?: { Status?: number; Message?: string }
    InterfaceResult?: Record<string, unknown>
  }

  export interface PutObjectParams {
    Bucket: string
    Key: string
    Body: string | Buffer | Uint8Array
    ACL?: string
    ContentType?: string
  }

  interface ObsClientInstance {
    putObject(params: PutObjectParams): Promise<ObsResult>
  }

  const ObsClient: { new (options: ObsClientOptions): ObsClientInstance }
  export default ObsClient
}

1. claude 进程什么时候停止？如何停止？turns进行中会停止吗？会不会由于 claude 进行过多出现资源耗尽的情况？
2. 会不会出现 claude 僵尸进程的情况？假如会出现你应该如何处理？
3. claude 进程在turns过程中用户发送纠偏/补充消息应该如何处理？
4. chat页面url中需要携带 workspaceDir + sessionId ，当然 workspaceDir 要进行 urlEncode 处理或者base64url处理；
5. 同一个 workspaceDir 下同时只允许一个活跃的 claude 进程；
6. 前后端的 traceId 务必要合理处理，确保出了问题方便跟踪；
7. 同一个用户同时最多只允许有 3 个活跃的会话（claude 进程）；假如想打开更多会话需要选择手动关闭某几个获取的会话（claude 进程）；
8. 用户退出登录后如何优雅关闭他打开的 claude 进程？
9. 日志中务必携带用户的 username，方便后面用户反馈问题可以尽快的定位到问题；
10. 日志文件每天产出一个格式为 console-2026-08-16.log；
11. 仔细思考还有哪些边界情况没有考虑到，或者没有考虑清楚的？务必确保边界情况考虑周全且清晰！


1. 针对每个活跃会话是不是要有一个 SessionContext 然后使用 Map<{workspaceDir}, SessionContext> 来存储；
2. SessionContext 下要包含如下属性：
    - username
    - workspaceDir
    - sessionId
    - createdAt
    - lastActiveAt
    - TokenUsage(包含输入总token，输出总token)
    - SSE 对象
    - 等等

3. 要创建一个统一的定时任务 每分钟扫描一遍所有的 SessionContext ，看到 lastActiveAt 跟当前时间对比超过 5 分钟的就直接杀死
4. 跟会话相关的接口请求头需要携带 sessionId 跟 workspaceDir
5. 所有接口请求头都需要携带 username
6. SessionContext关闭的时候要将当前会话总共有效生命时长，token用量等等信息记录下来；你得考虑一下这个表应该如何创建；
    - id
    - sessionId
    - workspaceDir
    - username
    - lifeCycle
    - tokenUsage(包含输入总token，输出总token)
    - createdAt
    - lastActiveAt
    - 等等

7. 你得好好思考 假如用户不在当前会话页面 但是当前会话弹出了 askUserQuestion ，用户切回当前会话页面的时候应该如何合理处理；然后还有 askUserQuestion 应该设置 5 分钟超时时间；
8. Claude Agent SDK 获取 SessionId 的时机要考虑清楚，每个请求都要携带sessionId，chat页面url中也要携带 sessionId 你要想清楚如何去实现；
9. SSE 断线重连，为了确保消息的完整性以及连贯性，你应该如何合理处理？
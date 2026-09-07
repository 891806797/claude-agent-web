Voice服务务必要实现的能力：
1. CPU深度优化，中文识别精准且延迟低。
2. 支持流式输入输出。
3. 优秀的探测开始结束。

模型选择：
主要是中文识别场景，最好支持一点英文；

交互模式：
两种模式都要实现，让用户去选择。

Rust 服务会挂在同一域名下；

该项目要在 D:\worker\msun\projects\agents\csm-ai\csm-voice-service 下实现；

并且要实现一个前端，方便后续测试以及管理；

参考项目：D:\worker\msun\projects\agents\csm-ai\csm-deploy-server
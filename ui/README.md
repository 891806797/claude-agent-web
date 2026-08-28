# claude-agent-web 前端

与 `csm-deploy-server/frontend` 范式完全对齐的前端框架（Tailwind v4 + Base UI + 暖灰设计系统）。本目录只提供框架骨架，业务页面按既有范式扩展。

## 技术栈

| 库                                           | 用途                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Vite 8 + React 19 + TypeScript 6             | 工程底座（`@` alias → `src/`）                                        |
| Tailwind CSS v4                              | 样式方案（`@tailwindcss/vite` 插件，无 tailwind.config）              |
| @base-ui/react + cva + clsx + tailwind-merge | 组件体系（shadcn 风格，`components.json` 已配置）                     |
| lucide-react                                 | 图标                                                                  |
| sonner                                       | toast（`@/components/ui/sonner` 统一封装，全局 `<Toaster />` 已挂载） |
| react-router-dom v7                          | 路由                                                                  |
| zustand                                      | 状态管理（`src/stores/`）                                             |
| prettier                                     | 格式化（singleQuote / semi: false / printWidth 100）                  |

## 全局色调

暖调沉稳设计系统，两个文件构成，**改色先看这里**：

- `src/assets/base.css` —— 暖灰阶梯变量（`--grey-*`、`--bg-*`、`--text-*`、边框/阴影/overlay）+ 滚动条 + 字体栈
- `src/assets/main.css` —— shadcn HSL 语义变量（`--background`/`--primary`…，含 `.dark`）+ Tailwind v4 `@theme inline` 颜色映射

## 常用命令

```bash
bun install        # 安装依赖
bun run dev        # 开发服务 http://localhost:5173（/api 代理到后端 3000）
bun run build      # tsc -b && vite build（根目录 bun run build 会把 ui/dist 嵌入可执行文件）
bun run format     # prettier 格式化
```

## 目录结构

```
src/
├── App.tsx              # 路由表（页面唯一登记处，页面本体在 pages/）
├── main.tsx             # 入口：BrowserRouter + <Toaster />
├── assets/              # base.css + main.css（全局色调，见上）
├── components/ui/       # shadcn 风格基础组件（button / sonner，按需追加）
├── lib/
│   ├── api.ts           # 类型化 API 客户端（解包 {data}，错误抛 ApiError 带 code/traceId）
│   └── utils.ts         # cn()
├── pages/               # 业务页面（home.tsx 为范式活教材）
└── stores/              # zustand（system.ts：/readyz 就绪检查）
```

## 与后端的契约

- 统一响应：成功 `{ data }` / 失败 `{ error: { code, message, traceId } }`，`lib/api.ts` 已按此封装
- 开发期 `/api`、`/openapi.json` 由 vite proxy 转发到 `http://localhost:3000`（先启动后端 `bun run dev`）

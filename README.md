# JourneyCraft

JourneyCraft 是一个面向旅游与校园场景的一体化出行平台，覆盖景点发现、路线规划、美食推荐、多人协同、旅行日记、收藏历史与消费复盘等完整体验。

## 当前版本

- 前端：React + TypeScript + Vite
- 服务端：Express + TypeScript
- 数据持久化：SQLite
- 文件存储：MinIO，未配置时自动回退到本地 `.uploads/`
- 部署方式：`npm start` 单服务运行，或 `docker compose up --build` 一键部署

## 本地开发

1. 安装依赖

```bash
npm install
```

2. 启动服务端

```bash
npm run dev:server
```

3. 启动前端

```bash
npm run dev:client
```

默认前端地址为 `http://localhost:5173`，通过 Vite 代理访问 `http://localhost:3000/api`。

启动前请配置前端地图环境变量：

```bash
cp .env.example .env.local
```

至少填写：

- `VITE_AMAP_KEY`
- `VITE_AMAP_SECURITY_JS_CODE`

## 生产构建

```bash
npm run build
npm start
```

应用默认监听 `http://localhost:3000`。

## 导入 OSM 地图数据

如果你有 `.osm.pbf` 文件，可以直接导入到 SQLite：

```bash
npm run import:osm -- /absolute/path/to/your.osm.pbf
```

当前项目已经支持把道路、路口图节点和 POI 写入以下表：

- `osm_imports`
- `osm_road_nodes`
- `osm_road_ways`
- `osm_road_edges`
- `osm_pois`

导入后可通过以下接口查看：

- `GET /api/osm/summary`
- `GET /api/osm/roads`
- `GET /api/osm/pois`

## Docker Compose

```bash
docker compose up --build
```

启动后：

- 应用：`http://localhost:3000`
- MinIO API：`http://localhost:9000`
- MinIO Console：`http://localhost:9001`

MinIO 默认账号：

- 用户名：`minioadmin`
- 密码：`minioadmin`

## 演示账号

- `demo1@journeycraft.app` / `123456`
- `demo2@journeycraft.app` / `123456`
- `demo3@journeycraft.app` / `123456`

## 说明

- 登录、注册、密码修改走真实后端 API。
- 地图底图与前端覆盖物使用高德 JavaScript API，路线规划仍由后端 OSM 路网算法返回。
- 收藏、历史、路线、日记、协同和资料编辑会自动同步到 SQLite。
- 头像、日记图集和视频通过 `/api/upload` 上传，部署到 Compose 时会进入 MinIO。
- 静态景点、校园、美食和路网为高质量种子数据，动态用户内容为可持续持久化数据。
# journeycraft-v2

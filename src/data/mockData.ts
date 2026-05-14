import type {
  BillRecord,
  Campus,
  FoodItem,
  GroupTrip,
  Journal,
  PreferenceTag,
  RoutePoi,
  RouteArea,
  RouteEdge,
  RouteNode,
  ScenicSpot,
  User
} from "../types.js";

const preferenceTags: PreferenceTag[] = [
  "自然风光",
  "人文建筑",
  "拍照出片",
  "夜游氛围",
  "亲子友好",
  "校园漫步",
  "咖啡甜品",
  "本地风味",
  "安静学习",
  "轻运动"
];

const cityPool = [
  "杭州",
  "上海",
  "苏州",
  "南京",
  "武汉",
  "厦门",
  "成都",
  "广州",
  "西安",
  "长沙"
];

const scenicThemes = [
  "湖滨",
  "古城",
  "滨江",
  "竹海",
  "博物",
  "湿地",
  "山野",
  "光影",
  "艺术",
  "夜市"
];

const campusThemes = [
  "书院",
  "科技",
  "湖景",
  "设计",
  "体育",
  "人文",
  "国际",
  "创客",
  "生态",
  "传媒"
];

const facilityTypes = [
  "游客中心",
  "洗手间",
  "咖啡站",
  "休息区",
  "校车站",
  "便利店",
  "观景台",
  "急救点",
  "共享单车点",
  "充电站",
  "文创店",
  "饮水处"
];

const foodCuisines = [
  "杭帮菜",
  "川味",
  "江浙小馆",
  "轻食沙拉",
  "咖啡甜品",
  "烧烤",
  "粤式茶点",
  "日式简餐",
  "面食",
  "融合料理"
];

const buildingCategories = [
  "图书馆",
  "教学楼",
  "实验楼",
  "艺术馆",
  "体育馆",
  "创业中心",
  "学生中心",
  "博物馆"
];

const names = [
  "林知夏",
  "顾一川",
  "沈沐言",
  "陆星河",
  "周雨桐",
  "何清越",
  "陈书意",
  "叶惊鸿",
  "许南舟",
  "程晚晴",
  "宋知遥",
  "白若川"
];

const days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function pick<T>(list: T[], index: number): T {
  return list[index % list.length];
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function mockImage(seed: string, width = 900, height = 600): string {
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

function dateOffset(daysAgo: number): string {
  const base = new Date("2026-05-10T09:00:00+08:00");
  base.setDate(base.getDate() - daysAgo);
  return base.toISOString();
}

function createRouteArea(id: string, name: string, areaType: "scenic" | "campus", index: number): RouteArea {
  const cols = 5;
  const rows = 4;
  const nodes: RouteNode[] = [];
  const edges: RouteEdge[] = [];
  const pois: RoutePoi[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const nodeId = `${id}-n${row}-${col}`;
      const nodeIndex = row * cols + col;
      const kind =
        nodeIndex === 0
          ? "gate"
          : nodeIndex % 6 === 0
            ? "landmark"
            : nodeIndex % 5 === 0
              ? "food"
              : nodeIndex % 4 === 0
                ? "facility"
                : nodeIndex % 3 === 0
                  ? "building"
                  : "junction";

      nodes.push({
        id: nodeId,
        x: 70 + col * 150 + (row % 2) * 10,
        y: 60 + row * 120,
        label:
          kind === "gate"
            ? "主入口"
            : kind === "landmark"
              ? `地标 ${nodeIndex}`
              : kind === "food"
                ? `餐饮点 ${nodeIndex}`
                : kind === "facility"
                  ? `服务点 ${nodeIndex}`
                  : kind === "building"
                    ? `建筑 ${nodeIndex}`
                    : `连接点 ${nodeIndex}`,
        kind
      });
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const current = `${id}-n${row}-${col}`;

      if (col < cols - 1) {
        const next = `${id}-n${row}-${col + 1}`;
        edges.push({
          from: current,
          to: next,
          distance: 180 + ((row + col + index) % 3) * 40,
          time: 3 + ((row + col + index) % 4),
          crowdPenalty: 1 + ((row + col + index) % 4),
          modes: ["walk", "bike", "shuttle"]
        });
      }

      if (row < rows - 1) {
        const next = `${id}-n${row + 1}-${col}`;
        edges.push({
          from: current,
          to: next,
          distance: 150 + ((row + col + index) % 4) * 35,
          time: 2 + ((row + col + index) % 3),
          crowdPenalty: 1 + ((row + col + index + 1) % 4),
          modes: col === 0 ? ["walk", "shuttle"] : ["walk", "bike", "shuttle"]
        });
      }
    }
  }

  const notableNodes = nodes.filter((node) => node.kind !== "junction").slice(0, 10);
  notableNodes.forEach((node, idx) => {
    pois.push({
      id: `${id}-poi-${idx + 1}`,
      name: node.label,
      nodeId: node.id,
      category: node.kind === "junction" ? "landmark" : node.kind
    });
  });

  return {
    id,
    name,
    areaType,
    description: `${name} 提供多目标路线规划、拍照点推荐、拥挤度规避与反向游览建议。`,
    heroImage: mockImage(`${id}-hero`, 1400, 900),
    nodes,
    edges,
    pois,
    facilities: facilityTypes.slice(0, 8).map((type, idx) => ({
      id: `${id}-facility-${idx + 1}`,
      name: `${type}${idx + 1}`,
      type,
      description: `${name} ${type}，适合中途补给与休整。`,
      openHours: `${pick(days, idx)} 至 ${pick(days, idx + 3)} 07:30 - 21:00`,
      crowd: 25 + ((idx + index) % 5) * 15,
      tags: [type, idx % 2 === 0 ? "补给" : "休息"],
      nodeId: notableNodes[idx]?.id
    })),
    photoSpots: [`${name} 中轴观景台`, `${name} 湖心平台`, `${name} 林荫步道转角`],
    reverseGuide: [`从北门切入可避开高峰人流`, `先走环线外圈更利于拍照`, `午后优先经过餐饮带和休息区`]
  };
}

export const routeAreas: RouteArea[] = [
  ...Array.from({ length: 6 }, (_, idx) =>
    createRouteArea(`route-scenic-${idx + 1}`, `${pick(scenicThemes, idx)}游览区`, "scenic", idx)
  ),
  ...Array.from({ length: 6 }, (_, idx) =>
    createRouteArea(`route-campus-${idx + 1}`, `${pick(campusThemes, idx)}校园`, "campus", idx + 6)
  )
];

export const scenicSpots: ScenicSpot[] = Array.from({ length: 120 }, (_, idx) => {
  const city = pick(cityPool, idx);
  const theme = pick(scenicThemes, idx);
  const preference = pick(preferenceTags, idx);

  return {
    id: `scenic-${idx + 1}`,
    name: `${city}${theme}目的地 ${idx + 1}`,
    city,
    address: `${city}市 ${theme}大道 ${120 + idx} 号`,
    summary: `适合半日到一日游的 ${theme} 场景，兼顾出片与休闲补给。`,
    description: `${city}${theme}目的地 ${idx + 1} 融合了城市漫步、夜游灯光、餐饮聚集与拍照动线，是 JourneyCraft 中最受欢迎的目的地之一。`,
    tags: [theme, preference, pick(preferenceTags, idx + 2), idx % 2 === 0 ? "热门打卡" : "深度体验"],
    rating: Number((4.2 + (idx % 7) * 0.09).toFixed(1)),
    popularity: 72 + (idx % 25),
    openHours: idx % 3 === 0 ? "08:30 - 22:00" : "全天开放",
    ticket: idx % 4 === 0 ? "免费" : `${48 + (idx % 5) * 20} 元`,
    serviceLink: "https://www.amap.com",
    images: [
      mockImage(`scenic-${idx + 1}-1`),
      mockImage(`scenic-${idx + 1}-2`),
      mockImage(`scenic-${idx + 1}-3`)
    ],
    routeAreaId: routeAreas[idx % 6].id,
    nearbyFoodIds: [],
    highlight: idx % 2 === 0 ? "黄昏光线和沿线补给特别友好" : "适合轻量路线和高频拍照停留"
  };
});

export const campuses: Campus[] = Array.from({ length: 90 }, (_, idx) => {
  const city = pick(cityPool, idx + 2);
  const theme = pick(campusThemes, idx);
  const routeAreaId = routeAreas[6 + (idx % 6)].id;

  return {
    id: `campus-${idx + 1}`,
    name: `${city}${theme}大学 ${idx + 1}`,
    city,
    address: `${city}市 学院路 ${80 + idx} 号`,
    summary: `以 ${theme} 氛围为核心的校园空间，适合访校、漫步和设施查找。`,
    description: `${city}${theme}大学 ${idx + 1} 拥有完整的教学、生活、运动与休闲节点，支持校内多目标路线规划、楼宇检索和设施查询。`,
    tags: [theme, "校园参观", pick(preferenceTags, idx + 3), idx % 2 === 0 ? "学术氛围" : "生活便利"],
    rating: Number((4.3 + (idx % 6) * 0.08).toFixed(1)),
    popularity: 68 + (idx % 23),
    openHours: "07:00 - 22:30",
    ticket: "免费",
    serviceLink: "https://www.amap.com",
    images: [
      mockImage(`campus-${idx + 1}-1`),
      mockImage(`campus-${idx + 1}-2`),
      mockImage(`campus-${idx + 1}-3`)
    ],
    routeAreaId,
    buildings: Array.from({ length: 20 }, (_, buildingIdx) => ({
      id: `campus-${idx + 1}-building-${buildingIdx + 1}`,
      name: `${pick(buildingCategories, buildingIdx)} ${buildingIdx + 1}`,
      category: pick(buildingCategories, buildingIdx),
      description: `承担 ${pick(buildingCategories, buildingIdx)} 场景中的教学、活动与服务功能，用户可在详情中查看开放时间与标签。`,
      openHours: buildingIdx % 3 === 0 ? "08:00 - 22:00" : "08:30 - 21:30",
      tags: [pick(preferenceTags, buildingIdx), buildingIdx % 2 === 0 ? "热门" : "安静"]
    })),
    facilities: Array.from({ length: 12 }, (_, facilityIdx) => ({
      id: `campus-${idx + 1}-facility-${facilityIdx + 1}`,
      name: `${pick(facilityTypes, facilityIdx)} ${facilityIdx + 1}`,
      type: pick(facilityTypes, facilityIdx),
      description: `面向访客和校内用户开放的 ${pick(facilityTypes, facilityIdx)}，支持导航接入与附近查询。`,
      openHours: "07:30 - 21:30",
      crowd: 20 + ((idx + facilityIdx) % 5) * 17,
      tags: [facilityIdx % 2 === 0 ? "便利" : "补给", pick(preferenceTags, facilityIdx + 1)]
    })),
    recommendedFoodIds: []
  };
});

export const foodItems: FoodItem[] = Array.from({ length: 180 }, (_, idx) => {
  const cuisine = pick(foodCuisines, idx);
  const scenic = scenicSpots[idx % scenicSpots.length];
  const campus = campuses[idx % campuses.length];
  const useCampus = idx % 2 === 0;

  return {
    id: `food-${idx + 1}`,
    name: `${pick(cityPool, idx)}${cuisine}餐桌 ${idx + 1}`,
    cuisine,
    price: 32 + (idx % 8) * 12,
    distance: 180 + (idx % 10) * 55,
    rating: Number((4.1 + (idx % 7) * 0.1).toFixed(1)),
    popularity: 60 + (idx % 30),
    tags: [cuisine, pick(preferenceTags, idx + 4), idx % 3 === 0 ? "适合小组" : "适合独行"],
    address: useCampus ? `${campus.name} 南区生活街` : `${scenic.name} 东侧漫游街`,
    summary: `主打 ${cuisine}，兼顾出行路线上手快、评分稳定和补给效率。`,
    signature: idx % 2 === 0 ? "招牌饭 / 面 / 甜品组合" : "主厨限定风味拼盘",
    images: [
      mockImage(`food-${idx + 1}-1`),
      mockImage(`food-${idx + 1}-2`),
      mockImage(`food-${idx + 1}-3`)
    ],
    serviceLink: "https://www.amap.com",
    scenicId: useCampus ? undefined : scenic.id,
    campusId: useCampus ? campus.id : undefined
  };
});

foodItems.forEach((item) => {
  if (item.scenicId) {
    const scenic = scenicSpots.find((entry) => entry.id === item.scenicId);
    scenic?.nearbyFoodIds.push(item.id);
  }

  if (item.campusId) {
    const campus = campuses.find((entry) => entry.id === item.campusId);
    campus?.recommendedFoodIds.push(item.id);
  }
});

export const users: User[] = Array.from({ length: 12 }, (_, idx) => ({
  id: `user-${idx + 1}`,
  name: names[idx],
  email: `demo${idx + 1}@journeycraft.app`,
  password: "123456",
  avatar: mockImage(`avatar-${idx + 1}`, 320, 320),
  bio: `${names[idx]} 喜欢把路线、餐饮和内容记录整理成自己的出行清单。`,
  joinedAt: dateOffset(140 - idx * 6),
  homeCampus: campuses[idx % campuses.length].name,
  preferences: [pick(preferenceTags, idx), pick(preferenceTags, idx + 2), pick(preferenceTags, idx + 4)]
}));

export const journals: Journal[] = Array.from({ length: 30 }, (_, idx) => {
  const scenic = scenicSpots[idx % scenicSpots.length];
  const author = users[idx % users.length];

  return {
    id: `journal-${idx + 1}`,
    scenicId: scenic.id,
    authorId: author.id,
    title: `${scenic.name} 的一天：第 ${idx + 1} 次轻量路线实验`,
    excerpt: `从入口到观景点，再到附近餐饮，这篇日记记录了 ${scenic.name} 最顺手的一条体验链路。`,
    content: `早上先从主入口进入，避开中部高峰，沿着林荫步道前往第一观景点。中午在附近挑了一家评分稳定的小馆补给，下午用环线把图集拍完，整个节奏很轻。JourneyCraft 的路线保存功能让我第二次来时几乎不用重做功课。`,
    cover: mockImage(`journal-cover-${idx + 1}`),
    gallery: [mockImage(`journal-${idx + 1}-1`), mockImage(`journal-${idx + 1}-2`), mockImage(`journal-${idx + 1}-3`)],
    tags: scenic.tags.slice(0, 3),
    likes: 34 + (idx % 12) * 6,
    rating: Number((4.2 + (idx % 6) * 0.12).toFixed(1)),
    commentCount: 2 + (idx % 4),
    createdAt: dateOffset(28 - idx),
    comments: Array.from({ length: 2 + (idx % 4) }, (_, commentIdx) => ({
      id: `journal-${idx + 1}-comment-${commentIdx + 1}`,
      userId: users[(idx + commentIdx + 1) % users.length].id,
      content:
        commentIdx % 2 === 0
          ? "这条路线的节奏很好，特别适合第一次去。"
          : "餐饮选择和拍照点的安排都很实用。",
      createdAt: dateOffset(12 - commentIdx)
    }))
  };
});

export const billRecords: BillRecord[] = Array.from({ length: 24 }, (_, idx) => ({
  id: `bill-${idx + 1}`,
  title: idx % 5 === 0 ? "城际交通" : idx % 4 === 0 ? "住宿补差" : idx % 3 === 0 ? "景区门票" : idx % 2 === 0 ? "餐饮补给" : "文创纪念",
  category: idx % 5 === 0 ? "交通" : idx % 4 === 0 ? "住宿" : idx % 3 === 0 ? "门票" : idx % 2 === 0 ? "餐饮" : "购物",
  amount: 38 + (idx % 7) * 56,
  date: `2026-04-${pad((idx % 25) + 1)}`,
  note: idx % 2 === 0 ? "与路线行程同步记录" : "手动补录",
  city: pick(cityPool, idx)
}));

export const groupTrips: GroupTrip[] = [
  {
    id: "group-1",
    name: "周末湖滨小分队",
    memberIds: users.slice(0, 4).map((user) => user.id),
    selectedAreaId: routeAreas[0].id,
    preferenceVotes: {
      "user-1": ["拍照出片", "咖啡甜品"],
      "user-2": ["自然风光", "轻运动"],
      "user-3": ["夜游氛围", "本地风味"],
      "user-4": ["拍照出片", "夜游氛围"]
    }
  },
  {
    id: "group-2",
    name: "访校路线讨论组",
    memberIds: users.slice(4, 8).map((user) => user.id),
    selectedAreaId: routeAreas[7].id,
    preferenceVotes: {
      "user-5": ["校园漫步", "安静学习"],
      "user-6": ["人文建筑", "咖啡甜品"],
      "user-7": ["校园漫步", "轻运动"],
      "user-8": ["安静学习", "人文建筑"]
    }
  },
  {
    id: "group-3",
    name: "深度内容采风团",
    memberIds: users.slice(8, 12).map((user) => user.id),
    selectedAreaId: routeAreas[3].id,
    preferenceVotes: {
      "user-9": ["本地风味", "拍照出片"],
      "user-10": ["自然风光", "轻运动"],
      "user-11": ["人文建筑", "本地风味"],
      "user-12": ["拍照出片", "自然风光"]
    }
  }
];

export const preferenceOptions = preferenceTags;

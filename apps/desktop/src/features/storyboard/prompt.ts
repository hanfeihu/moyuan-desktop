// 拆分镜 prompt 的固定开头，用于在任务列表中识别并隐藏这类辅助任务
export const BREAKDOWN_PROMPT_MARKER = '你是专业的短剧分镜师'

export function buildBreakdownPrompt(script: string) {
  const trimmed = script.trim()
  return `${BREAKDOWN_PROMPT_MARKER}。请把下面的剧本拆分为一组分镜镜头。

每个镜头包含四个字段：
- scene: 场景描述（地点、时间、氛围、镜头景别），用于建立画面
- dialogue: 该镜头的台词或旁白（如果没有则填空字符串 ""）
- visual: 画面描述，必须是具体、视觉化、可直接用于文生图的提示词（包含主体、动作、构图、光线、风格），不要写成抽象剧情概括
- characters: 出现在该镜头中的人物名字数组（字符串数组；没有人物则填 []。名字要与剧本中的人物称呼一致）

要求：
1. 按剧情顺序拆分，镜头数量根据剧本长度自然决定，通常 4-12 个。
2. 只输出一个 JSON，用 \`\`\`json 代码块包裹，不要输出任何额外的解释文字。
3. JSON 结构严格如下：

\`\`\`json
{
  "shots": [
    { "scene": "", "dialogue": "", "visual": "", "characters": [] }
  ]
}
\`\`\`

剧本如下：
<<<
${trimmed}
>>>`
}

// 人物提取 prompt 的固定开头，用于在任务列表中识别并隐藏这类辅助任务
export const CHARACTER_EXTRACTION_MARKER = '你是专业的短剧选角与人物设定师'

export function buildCharacterExtractionPrompt(script: string) {
  const trimmed = script.trim()
  return `${CHARACTER_EXTRACTION_MARKER}。请从下面的剧本/小说中提取所有出场人物。

每个人物包含两个字段：
- name: 人物名字（与剧本中的称呼一致）
- appearance: 外貌描述，尽量具体、视觉化（年龄段、性别、发型发色、脸型五官、身材、服饰风格、气质），可直接用于生成角色定妆图；若剧本未明写，可根据角色身份与剧情合理补全

要求：
1. 只提取有名有姓或有明确称谓的主要/次要人物，路人不提取。
2. 只输出一个 JSON，用 \`\`\`json 代码块包裹，不要输出任何额外的解释文字。
3. JSON 结构严格如下：

\`\`\`json
{
  "characters": [
    { "name": "", "appearance": "" }
  ]
}
\`\`\`

剧本如下：
<<<
${trimmed}
>>>`
}

// 生成角色定妆图时追加的固定后缀：角色三视图设定表，强化跨镜一致性
export const CHARACTER_SHEET_SUFFIX =
  '要求：人物身体比例均衡，展示全身视角并保留清晰的面部细节；输出角色三视图（正面、背面、侧面）；画面左侧单独留出一块区域展示该角色的正面大头照特写；纯白色背景；图中右侧的所有全身像区域必须保持完全一致、互不修改，作为后续分镜的角色参考图。'

// 真人短剧：定妆图与分镜图统一的写实风格前缀
export const REALISTIC_STYLE_PREFIX = '影视写实风格，真人实拍质感，电影级打光与肤质细节。'

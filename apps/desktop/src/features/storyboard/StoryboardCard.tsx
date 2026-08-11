import { Image as ImageIcon, Loader2, ScanFace, Trash2, X } from 'lucide-react'
import type { ShotCard } from './types'

const norm = (value: string) => value.trim().toLowerCase()

export function StoryboardCard({
  card,
  libraryNames,
  namesWithImage,
  onEdit,
  onGenerate,
  onRemove,
  onAddCharacter,
  onRemoveCharacter,
  onMaskFace,
}: {
  card: ShotCard
  libraryNames: string[]
  namesWithImage: Set<string>
  onEdit: (patch: Partial<Pick<ShotCard, 'scene' | 'dialogue' | 'visualPrompt'>>) => void
  onGenerate: () => void
  onRemove: () => void
  onAddCharacter: (name: string) => void
  onRemoveCharacter: (name: string) => void
  onMaskFace: () => void
}) {
  const generating = card.imageStatus === 'generating'
  // 可供添加的角色（库里有、但本镜还没关联的）
  const attachedSet = new Set(card.characterNames.map(norm))
  const addableNames = libraryNames.filter((name) => name.trim() && !attachedSet.has(norm(name)))
  return (
    <div className="storyboard-card">
      <div className="storyboard-card-header">
        <span className="storyboard-card-index">镜 {card.index}</span>
        <button className="storyboard-card-remove" onClick={onRemove} title="删除分镜" type="button">
          <Trash2 size={13} />
        </button>
      </div>

      <div className="storyboard-image-wrap">
        {card.imageUrl ? (
          <img className="storyboard-image" alt={`镜头 ${card.index} 画面`} src={card.imageUrl} />
        ) : (
          <div className={`storyboard-image placeholder ${card.imageStatus}`}>
            {generating ? <Loader2 className="spin" size={18} /> : <ImageIcon size={18} />}
            <span className="storyboard-image-status">
              {generating ? '生成中…' : card.imageStatus === 'error' ? card.imageError || '生成失败' : '尚未生成'}
            </span>
          </div>
        )}
      </div>

      <div className="storyboard-field">
        <span>出场人物</span>
        <div className="character-chips">
          {card.characterNames.length === 0 ? <span className="character-chips-empty">无</span> : null}
          {card.characterNames.map((name) => {
            const missing = !namesWithImage.has(norm(name))
            return (
              <span className={`character-chip ${missing ? 'missing' : ''}`} key={name} title={missing ? '该角色尚无定妆图，生成时不会垫图' : '生成时会用该角色定妆图垫图'}>
                {name}
                {missing ? '·无图' : ''}
                <button onClick={() => onRemoveCharacter(name)} title="移除" type="button">
                  <X size={10} />
                </button>
              </span>
            )
          })}
          {addableNames.length ? (
            <select
              className="character-chip-add"
              value=""
              onChange={(event) => {
                if (event.target.value) onAddCharacter(event.target.value)
              }}
            >
              <option value="">+ 添加角色</option>
              {addableNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      <label className="storyboard-field">
        <span>场景</span>
        <textarea
          className="storyboard-textarea"
          rows={2}
          value={card.scene}
          placeholder="地点 / 时间 / 氛围 / 景别"
          onChange={(event) => onEdit({ scene: event.target.value })}
        />
      </label>

      <label className="storyboard-field">
        <span>台词</span>
        <textarea
          className="storyboard-textarea"
          rows={2}
          value={card.dialogue}
          placeholder="该镜台词或旁白（可空）"
          onChange={(event) => onEdit({ dialogue: event.target.value })}
        />
      </label>

      <label className="storyboard-field">
        <span>画面描述</span>
        <textarea
          className="storyboard-textarea"
          rows={3}
          value={card.visualPrompt}
          placeholder="可直接用于文生图的提示词"
          onChange={(event) => onEdit({ visualPrompt: event.target.value })}
        />
      </label>

      <div className="storyboard-card-actions">
        <button
          className="storyboard-generate-button"
          disabled={generating || !card.visualPrompt.trim()}
          onClick={onGenerate}
          type="button"
        >
          {generating ? <Loader2 className="spin" size={14} /> : <ImageIcon size={14} />}
          <span>{card.imageUrl ? '重新生成画面' : '生成画面'}</span>
        </button>
        {card.imageUrl ? (
          <button className="storyboard-mask-button" onClick={onMaskFace} title="遮挡人脸后替换本图，用于规避视频生成的真人限制" type="button">
            <ScanFace size={14} />
            <span>遮脸</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

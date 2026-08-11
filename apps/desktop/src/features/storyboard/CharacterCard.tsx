import { Image as ImageIcon, Loader2, ScanFace, Trash2, UserRound } from 'lucide-react'
import type { Character } from './characters'

export function CharacterCard({
  character,
  onEdit,
  onGenerate,
  onRemove,
  onMaskFace,
}: {
  character: Character
  onEdit: (patch: Partial<Pick<Character, 'name' | 'appearance'>>) => void
  onGenerate: () => void
  onRemove: () => void
  onMaskFace: () => void
}) {
  const generating = character.imageStatus === 'generating'
  return (
    <div className="character-card">
      <div className="storyboard-card-header">
        <span className="storyboard-card-index">
          <UserRound size={13} /> 人物
        </span>
        <button className="storyboard-card-remove" onClick={onRemove} title="删除人物" type="button">
          <Trash2 size={13} />
        </button>
      </div>

      <div className="storyboard-image-wrap">
        {character.refImageUrl ? (
          <img className="storyboard-image" alt={`${character.name || '人物'} 定妆`} src={character.refImageUrl} />
        ) : (
          <div className={`storyboard-image placeholder ${character.imageStatus}`}>
            {generating ? <Loader2 className="spin" size={18} /> : <UserRound size={18} />}
            <span className="storyboard-image-status">
              {generating ? '生成中…' : character.imageStatus === 'error' ? character.imageError || '生成失败' : '尚无定妆图'}
            </span>
          </div>
        )}
      </div>

      <label className="storyboard-field">
        <span>角色名</span>
        <input
          className="storyboard-textarea character-name-input"
          value={character.name}
          placeholder="如：林晚"
          onChange={(event) => onEdit({ name: event.target.value })}
        />
      </label>

      <label className="storyboard-field">
        <span>外貌描述</span>
        <textarea
          className="storyboard-textarea"
          rows={3}
          value={character.appearance}
          placeholder="年龄、发型、服饰、气质等，用于生成定妆参考图"
          onChange={(event) => onEdit({ appearance: event.target.value })}
        />
      </label>

      <div className="storyboard-card-actions">
        <button
          className="storyboard-generate-button"
          disabled={generating || !character.appearance.trim()}
          onClick={onGenerate}
          type="button"
        >
          {generating ? <Loader2 className="spin" size={14} /> : <ImageIcon size={14} />}
          <span>{character.refImageUrl ? '重新生成定妆' : '生成定妆图'}</span>
        </button>
        {character.refImageUrl ? (
          <button className="storyboard-mask-button" onClick={onMaskFace} title="遮挡人脸后替换定妆图，用于规避视频生成的真人限制" type="button">
            <ScanFace size={14} />
            <span>遮脸</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

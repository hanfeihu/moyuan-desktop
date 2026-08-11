import { Loader2, Plus, UserRound, Wand2 } from 'lucide-react'
import type { Character } from './characters'
import { CharacterCard } from './CharacterCard'

export function CharacterBoard({
  characters,
  extractStatus,
  extractError,
  onAdd,
  onExtract,
  onEdit,
  onGenerate,
  onRemove,
  onMaskFace,
}: {
  characters: Character[]
  extractStatus: 'idle' | 'extracting' | 'error'
  extractError: string
  onAdd: () => void
  onExtract: () => void
  onEdit: (id: string, patch: Partial<Pick<Character, 'name' | 'appearance'>>) => void
  onGenerate: (id: string) => void
  onRemove: (id: string) => void
  onMaskFace: (id: string) => void
}) {
  const extracting = extractStatus === 'extracting'
  const extractButton = (
    <button className="character-extract-button" disabled={extracting} onClick={onExtract} type="button">
      {extracting ? <Loader2 className="spin" size={14} /> : <Wand2 size={14} />}
      <span>{extracting ? '提取中…' : '从剧本提取人物'}</span>
    </button>
  )

  if (!characters.length) {
    return (
      <div className="storyboard-board">
        <div className="storyboard-empty">
          <UserRound size={22} />
          <p>先设计人物：可让 AI 从当前对话的剧本里自动提取人物，或手动新增。生成定妆图后，分镜里出现该角色的镜头会自动用它「垫图」，保证角色一致。</p>
          {extractError ? <p className="storyboard-empty-error">{extractError}</p> : null}
          {extractButton}
          <button className="storyboard-add-button" onClick={onAdd} type="button">
            <Plus size={14} />
            <span>手动新增人物</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="storyboard-board">
      {extractError ? <div className="storyboard-board-error">{extractError}</div> : null}
      <div className="character-toolbar">{extractButton}</div>
      <div className="storyboard-cards">
        {characters.map((character) => (
          <CharacterCard
            key={character.id}
            character={character}
            onEdit={(patch) => onEdit(character.id, patch)}
            onGenerate={() => onGenerate(character.id)}
            onRemove={() => onRemove(character.id)}
            onMaskFace={() => onMaskFace(character.id)}
          />
        ))}
      </div>
      <button className="storyboard-add-button" onClick={onAdd} type="button">
        <Plus size={14} />
        <span>新增人物</span>
      </button>
    </div>
  )
}

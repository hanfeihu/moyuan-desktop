import { Clapperboard, Loader2, Plus } from 'lucide-react'
import type { Character } from './characters'
import type { ShotCard, Storyboard, StoryboardStatus } from './types'
import { StoryboardCard } from './StoryboardCard'

const norm = (value: string) => value.trim().toLowerCase()

export function StoryboardBoard({
  board,
  status,
  error,
  characters,
  onGenerate,
  onEditCard,
  onAddCard,
  onRemoveCard,
  onAddCharacterToShot,
  onRemoveCharacterFromShot,
  onMaskShot,
}: {
  board: Storyboard | null
  status: StoryboardStatus
  error: string
  characters: Character[]
  onGenerate: (cardId: string) => void
  onEditCard: (cardId: string, patch: Partial<Pick<ShotCard, 'scene' | 'dialogue' | 'visualPrompt'>>) => void
  onAddCard: () => void
  onRemoveCard: (cardId: string) => void
  onAddCharacterToShot: (cardId: string, name: string) => void
  onRemoveCharacterFromShot: (cardId: string, name: string) => void
  onMaskShot: (cardId: string) => void
}) {
  const busy = status === 'requesting' || status === 'parsing'
  const hasCards = Boolean(board?.cards.length)
  const libraryNames = characters.map((c) => c.name).filter((name) => name.trim())
  const namesWithImage = new Set(characters.filter((c) => c.refImageUrl).map((c) => norm(c.name)))

  if (busy && !hasCards) {
    return (
      <div className="storyboard-board">
        <div className="storyboard-empty">
          <Loader2 className="spin" size={20} />
          <p>{status === 'requesting' ? '正在请求拆分镜…' : '正在解析分镜…'}</p>
        </div>
      </div>
    )
  }

  if (!hasCards) {
    return (
      <div className="storyboard-board">
        <div className="storyboard-empty">
          <Clapperboard size={22} />
          <p>开启输入框的「分镜模式」，输入一段短剧剧本并发送，AI 会自动拆成分镜卡。</p>
          {error ? <p className="storyboard-empty-error">{error}</p> : null}
          <button className="storyboard-add-button" onClick={onAddCard} type="button">
            <Plus size={14} />
            <span>手动新增分镜</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="storyboard-board">
      {error ? <div className="storyboard-board-error">{error}</div> : null}
      <div className="storyboard-cards">
        {board!.cards.map((card) => (
          <StoryboardCard
            key={card.id}
            card={card}
            libraryNames={libraryNames}
            namesWithImage={namesWithImage}
            onEdit={(patch) => onEditCard(card.id, patch)}
            onGenerate={() => onGenerate(card.id)}
            onRemove={() => onRemoveCard(card.id)}
            onAddCharacter={(name) => onAddCharacterToShot(card.id, name)}
            onRemoveCharacter={(name) => onRemoveCharacterFromShot(card.id, name)}
            onMaskFace={() => onMaskShot(card.id)}
          />
        ))}
      </div>
      <button className="storyboard-add-button" onClick={onAddCard} type="button">
        <Plus size={14} />
        <span>新增分镜</span>
      </button>
    </div>
  )
}

export type ShotImageStatus = 'idle' | 'generating' | 'done' | 'error'

export type ShotCard = {
  id: string
  index: number
  scene: string
  dialogue: string
  visualPrompt: string
  characterNames: string[]
  imageUrl?: string
  imageTaskId?: string
  imageStatus: ShotImageStatus
  imageError?: string
}

export type Storyboard = {
  taskId: string
  createdAt: number
  updatedAt: number
  cards: ShotCard[]
}

export type StoryboardStatus = 'idle' | 'requesting' | 'parsing' | 'ready' | 'error'

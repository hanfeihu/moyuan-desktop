import type { CodexTaskEvent } from '@eaw/shared'
import type { TaskRecord } from '../tasks/types.js'
import type { EnterpriseSkillSet, MoyuanToolCall, RuntimeRunOptions } from './contracts.js'
import { generateImage, inferImageSize } from './image.js'
import { generateVideo, type VideoStatusUpdate } from './video.js'

type PushEvent = (record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) => void

type ToolExecutionBase = {
  pushEvent: PushEvent
  record: TaskRecord
  runtimeRoot: string
  saveStore: () => Promise<void>
}

type ImageExecutionOptions = ToolExecutionBase & {
  model?: string
  options: RuntimeRunOptions
  prompt: string
  size: string
  skills: EnterpriseSkillSet
}

type ToolCallExecutionOptions = ToolExecutionBase & {
  options: RuntimeRunOptions
  prompt: string
  skills: EnterpriseSkillSet
  toolCall: MoyuanToolCall
}

export async function runImageGenerationTool({ record, prompt, runtimeRoot, size, model, options, skills, saveStore, pushEvent }: ImageExecutionOptions) {
  try {
    record.task.status = 'running'
    record.task.updatedAt = new Date().toISOString()
    await saveStore()

    const image = await generateImage({ prompt, runtimeRoot, size, model, options, skills })
    record.task.status = 'completed'
    record.task.updatedAt = new Date().toISOString()
    record.task.generatedImages = [...(record.task.generatedImages ?? []), image]
    pushEvent(record, {
      taskId: record.task.id,
      type: 'output.added',
      role: 'system',
      content: '',
      output: {
        id: `image-${image.id}`,
        type: 'image',
        title: '生成图片',
        url: image.url,
        metadata: { model: image.model, prompt: image.prompt, size: image.size, usageTokens: image.usageTokens },
        createdAt: image.createdAt,
      },
      source: {
        id: `skill-image-${image.id}`,
        type: 'skill',
        title: '图片生成技能',
        metadata: { model: image.model },
        createdAt: image.createdAt,
      },
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'message',
      role: 'assistant',
      content: `![${prompt}](${image.url})`,
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.completed',
      role: 'system',
      content: '图片生成完成',
    })
  } catch (error) {
    record.task.status = 'failed'
    record.task.updatedAt = new Date().toISOString()
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.failed',
      role: 'system',
      content: `图片生成失败：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    await saveStore()
  }
}

async function runVideoGenerationTool({ record, prompt, toolCall, options, skills, saveStore, pushEvent }: ToolCallExecutionOptions) {
  if (toolCall.tool !== 'video_generation') return

  const itemId = `skill-video-${Date.now()}`
  const video = skills.videoGeneration
  const initialMetadata = {
    duration: toolCall.duration ?? video?.defaultDuration,
    model: toolCall.model ?? video?.defaultModel,
    prompt,
    ratio: toolCall.ratio ?? video?.defaultRatio,
    resolution: video?.defaultResolution,
  }

  const pushVideoStatus = (update: VideoStatusUpdate) => {
    pushEvent(record, {
      taskId: record.task.id,
      type: 'tool',
      role: 'tool',
      content: update.content,
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'item.delta',
      role: 'system',
      content: '',
      itemId,
      item: {
        id: itemId,
        type: 'video_generation',
        title: '生成视频',
        status: 'in_progress',
        content: update.content,
        metadata: {
          ...initialMetadata,
          lastCheckedAt: new Date().toISOString(),
          providerTaskId: update.taskId,
          rawStatus: update.status,
          usageTokens: update.usageTokens,
          videoUrl: update.videoUrl,
        },
      },
    })
  }

  try {
    record.task.status = 'running'
    record.task.updatedAt = new Date().toISOString()
    pushEvent(record, {
      taskId: record.task.id,
      type: 'item.started',
      role: 'system',
      content: '',
      itemId,
      item: {
        id: itemId,
        type: 'video_generation',
        title: '生成视频',
        status: 'in_progress',
        content: '准备调用视频生成服务',
        metadata: initialMetadata,
      },
    })
    await saveStore()

    const generatedVideo = await generateVideo(prompt, toolCall, options, skills, pushVideoStatus)
    record.task.status = 'completed'
    record.task.updatedAt = new Date().toISOString()
    record.task.generatedVideos = [...(record.task.generatedVideos ?? []), generatedVideo]
    pushEvent(record, {
      taskId: record.task.id,
      type: 'item.completed',
      role: 'system',
      content: '视频生成完成',
      itemId,
      item: {
        id: itemId,
        type: 'video_generation',
        title: '生成视频',
        status: 'completed',
        content: '视频生成完成',
        metadata: { ...initialMetadata, providerTaskId: generatedVideo.id, url: generatedVideo.url },
      },
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'output.added',
      role: 'system',
      content: '',
      output: {
        id: `video-${generatedVideo.id}`,
        type: 'video',
        title: '生成视频',
        url: generatedVideo.url,
        taskItemId: itemId,
        metadata: { duration: generatedVideo.duration, model: generatedVideo.model, prompt: generatedVideo.prompt, ratio: generatedVideo.ratio, resolution: generatedVideo.resolution, usageTokens: generatedVideo.usageTokens },
        createdAt: generatedVideo.createdAt,
      },
      source: {
        id: `skill-video-${generatedVideo.id}`,
        type: 'skill',
        title: '视频生成技能',
        metadata: { model: generatedVideo.model },
        createdAt: generatedVideo.createdAt,
      },
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'message',
      role: 'assistant',
      content: `![${prompt}](${generatedVideo.url})`,
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.completed',
      role: 'system',
      content: '视频生成完成',
    })
  } catch (error) {
    record.task.status = 'failed'
    record.task.updatedAt = new Date().toISOString()
    pushEvent(record, {
      taskId: record.task.id,
      type: 'item.completed',
      role: 'system',
      content: `视频生成失败：${error instanceof Error ? error.message : String(error)}`,
      itemId,
      item: {
        id: itemId,
        type: 'video_generation',
        title: '生成视频',
        status: 'failed',
        content: error instanceof Error ? error.message : String(error),
      },
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.failed',
      role: 'system',
      content: `视频生成失败：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    await saveStore()
  }
}

export async function runMoyuanToolCall(context: ToolCallExecutionOptions) {
  const { toolCall, prompt } = context
  if (toolCall.tool === 'image_generation') {
    await runImageGenerationTool({
      ...context,
      prompt: toolCall.prompt ?? prompt,
      size: toolCall.size ?? inferImageSize(toolCall.prompt ?? prompt),
      model: toolCall.model,
    })
    return
  }

  await runVideoGenerationTool({
    ...context,
    prompt: toolCall.prompt ?? prompt,
  })
}

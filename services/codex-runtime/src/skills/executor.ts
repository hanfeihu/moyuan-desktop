import type { CodexTaskEvent } from '@eaw/shared'
import type { TaskRecord } from '../tasks/types.js'
import type { EnterpriseSkillSet, MoyuanToolCall, RuntimeRunOptions } from './contracts.js'
import { generateImage, inferImageSize } from './image.js'
import { generateVideo } from './video.js'

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

  try {
    record.task.status = 'running'
    record.task.updatedAt = new Date().toISOString()
    await saveStore()

    const video = await generateVideo(prompt, toolCall, options, skills, (content) => {
      pushEvent(record, {
        taskId: record.task.id,
        type: 'tool',
        role: 'tool',
        content,
      })
    })
    record.task.status = 'completed'
    record.task.updatedAt = new Date().toISOString()
    record.task.generatedVideos = [...(record.task.generatedVideos ?? []), video]
    pushEvent(record, {
      taskId: record.task.id,
      type: 'output.added',
      role: 'system',
      content: '',
      output: {
        id: `video-${video.id}`,
        type: 'video',
        title: '生成视频',
        url: video.url,
        metadata: { duration: video.duration, model: video.model, prompt: video.prompt, ratio: video.ratio, resolution: video.resolution, usageTokens: video.usageTokens },
        createdAt: video.createdAt,
      },
      source: {
        id: `skill-video-${video.id}`,
        type: 'skill',
        title: '视频生成技能',
        metadata: { model: video.model },
        createdAt: video.createdAt,
      },
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'message',
      role: 'assistant',
      content: `![${prompt}](${video.url})`,
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

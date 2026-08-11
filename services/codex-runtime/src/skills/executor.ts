import type { CodexTaskEvent } from '@eaw/shared'
import type { TaskRecord } from '../tasks/types.js'
import type { EnterpriseSkillSet, MoyuanToolCall, RuntimeRunOptions } from './contracts.js'
import { buildImageFailureAssistantMessage, generateImage, imageInputsFromAttachments, inferImageSize } from './image.js'
import { buildVideoFailureAssistantMessage, generateVideo, type VideoStatusUpdate } from './video.js'

type PushEvent = (record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) => void

type ToolExecutionBase = {
  pushEvent: PushEvent
  record: TaskRecord
  runtimeRoot: string
  saveStore: () => Promise<void>
}

type ImageExecutionOptions = ToolExecutionBase & {
  images?: Extract<MoyuanToolCall, { tool: 'image_generation' }>['images']
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

export async function runImageGenerationTool({ images: requestedImages, record, prompt, runtimeRoot, size, model, options, skills, saveStore, pushEvent }: ImageExecutionOptions) {
  const itemId = `skill-image-${Date.now()}`
  const images = requestedImages?.length ? requestedImages : imageInputsFromAttachments(record.currentAttachments)
  const initialMetadata = {
    imageCount: images.length,
    model: model ?? skills.imageGeneration.defaultModel,
    prompt,
    size,
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
        type: 'image_generation',
        title: '生成图片',
        status: 'in_progress',
        content: '准备调用图片生成服务',
        metadata: initialMetadata,
      },
    })
    await saveStore()

    const image = await generateImage({ images, prompt, runtimeRoot, size, model, options, skills })
    record.task.status = 'completed'
    record.task.updatedAt = new Date().toISOString()
    record.task.generatedImages = [...(record.task.generatedImages ?? []), image]
    pushEvent(record, {
      taskId: record.task.id,
      type: 'item.completed',
      role: 'system',
      content: '图片生成完成',
      itemId,
      item: {
        id: itemId,
        type: 'image_generation',
        title: '生成图片',
        status: 'completed',
        content: '图片生成完成',
        metadata: { ...initialMetadata, url: image.url },
      },
    })
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
        taskItemId: itemId,
        metadata: { billableCny: image.billableCny, billableProviderTokens: image.billableProviderTokens, costCny: image.costCny, deductionFactor: image.deductionFactor, model: image.model, prompt: image.prompt, rawTokens: image.rawTokens, size: image.size, usageTokens: image.usageTokens },
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
    const errorMessage = error instanceof Error ? error.message : String(error)
    const diagnostic = error && typeof error === 'object' ? (error as { diagnostic?: unknown }).diagnostic : undefined
    const assistantMessage = buildImageFailureAssistantMessage(errorMessage, diagnostic && typeof diagnostic === 'object' ? diagnostic : undefined)
    record.handledSkillOutcomes ??= new Set()
    record.handledSkillOutcomes.add('image_generation')
    record.task.status = 'completed'
    record.task.updatedAt = new Date().toISOString()
    pushEvent(record, {
      taskId: record.task.id,
      type: 'item.completed',
      role: 'system',
      content: '图片请求已处理',
      itemId,
      item: {
        id: itemId,
        type: 'image_generation',
        title: '生成图片',
        status: 'completed',
        content: errorMessage,
        metadata: {
          ...initialMetadata,
          diagnostic,
          handledFailure: true,
          reason: errorMessage,
        },
      },
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'message',
      role: 'assistant',
      content: assistantMessage,
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.completed',
      role: 'system',
      content: '图片生成请求已处理',
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
          lastFrameUrl: update.lastFrameUrl,
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
        metadata: { ...initialMetadata, providerTaskId: generatedVideo.id, returnLastFrame: generatedVideo.returnLastFrame, lastFrameUrl: generatedVideo.lastFrameUrl, url: generatedVideo.url },
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
        metadata: { billableCny: generatedVideo.billableCny, billableProviderTokens: generatedVideo.billableProviderTokens, costCny: generatedVideo.costCny, deductionFactor: generatedVideo.deductionFactor, duration: generatedVideo.duration, model: generatedVideo.model, prompt: generatedVideo.prompt, ratio: generatedVideo.ratio, rawTokens: generatedVideo.rawTokens, resolution: generatedVideo.resolution, returnLastFrame: generatedVideo.returnLastFrame, lastFrameUrl: generatedVideo.lastFrameUrl, usageTokens: generatedVideo.usageTokens },
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
    if (generatedVideo.lastFrameUrl) {
      pushEvent(record, {
        taskId: record.task.id,
        type: 'output.added',
        role: 'system',
        content: '',
        output: {
          id: `video-last-frame-${generatedVideo.id}`,
          type: 'image',
          title: '尾帧图片',
          url: generatedVideo.lastFrameUrl,
          taskItemId: itemId,
          metadata: {
            model: generatedVideo.model,
            prompt: generatedVideo.prompt,
            sourceVideoId: generatedVideo.id,
            usageTokens: generatedVideo.usageTokens,
          },
          createdAt: generatedVideo.createdAt,
        },
      })
    }
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
    const errorMessage = error instanceof Error ? error.message : String(error)
    const assistantMessage = buildVideoFailureAssistantMessage(errorMessage)
    record.handledSkillOutcomes ??= new Set()
    record.handledSkillOutcomes.add('video_generation')
    record.task.status = 'completed'
    record.task.updatedAt = new Date().toISOString()
    pushEvent(record, {
      taskId: record.task.id,
      type: 'item.completed',
      role: 'system',
      content: '视频请求已处理',
      itemId,
      item: {
        id: itemId,
        type: 'video_generation',
        title: '生成视频',
        status: 'completed',
        content: errorMessage,
        metadata: {
          ...initialMetadata,
          handledFailure: true,
          reason: errorMessage,
        },
      },
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'message',
      role: 'assistant',
      content: assistantMessage,
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.completed',
      role: 'system',
      content: '视频生成请求已处理',
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
      images: toolCall.images,
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

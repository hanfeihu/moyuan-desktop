import type { RuntimeAttachment } from '@eaw/shared'

export function attachmentDraftPreviewUrl(attachment: RuntimeAttachment) {
  return attachment.localUrl ?? attachment.dataUrl ?? attachment.storageUrl ?? ''
}

export function attachmentHistoryPreviewUrl(attachment: RuntimeAttachment) {
  return attachment.storageUrl ?? attachment.dataUrl ?? attachment.localUrl ?? ''
}

export function attachmentForPersistence(attachment: RuntimeAttachment): RuntimeAttachment {
  if (!attachment.localUrl?.startsWith('blob:')) return attachment
  const { localUrl: _localUrl, ...persisted } = attachment
  return persisted
}

export function revokeAttachmentPreview(attachment: RuntimeAttachment) {
  if (attachment.localUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.localUrl)
}

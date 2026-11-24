const FACINGS = new Set(['reference', 'viewer-left', 'viewer-right'])

const normalizeSingleActionContract = (value = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['loop', 'facing', 'camera'].includes(key))) {
    throw new Error('动作设置无效')
  }
  const { loop = false, facing = 'reference', camera = 'locked' } = value
  if (typeof loop !== 'boolean' || !FACINGS.has(facing) || camera !== 'locked') {
    throw new Error('动作播放、朝向或镜头设置无效')
  }
  return { loop, facing, camera }
}

const resolveActionLoop = (action = {}) => action.actionContract?.loop ?? action.loop

const describeActionFacing = (facing) => facing === 'reference'
  ? 'preserve the reference character’s facing and viewpoint'
  : `face toward the ${facing.slice('viewer-'.length)} edge of the image as seen by the viewer (not the character’s own left or right)`

module.exports = { describeActionFacing, normalizeSingleActionContract, resolveActionLoop }

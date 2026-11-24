const { supportsCanonicalRig } = require('./canonical-support-rig')
const RIG_REPAIR_CODES = new Set([
  'visual-score-style-below-minimum',
  'visual-defect-style-drift',
  'visual-score-crossFrame-below-minimum',
  'visual-defect-cross-frame-inconsistent',
  'visual-score-actionReadability-below-minimum',
  'visual-defect-action-unreadable',
  'body-scale-variance-high',
  'frame-edge-contact',
  'loop-seam-too-large',
  'motion-is-static'
])

const shouldUseCanonicalRig = ({ actionId, characterClass, attemptKind, failureCodes }) => (
  attemptKind === 'repair' && supportsCanonicalRig({ actionId, characterClass }) &&
  Array.isArray(failureCodes) && failureCodes.some(code => RIG_REPAIR_CODES.has(code))
)

const createActionCandidateRenderer = ({ action, characterClass, generateVideo, generateRig }) => async (request) => {
  const useRig = shouldUseCanonicalRig({ ...request, actionId: action.actionId, characterClass })
  return useRig ? generateRig(request) : generateVideo(request)
}
module.exports = { createActionCandidateRenderer, shouldUseCanonicalRig }

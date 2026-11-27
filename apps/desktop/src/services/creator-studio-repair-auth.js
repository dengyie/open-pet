const { createHmac, timingSafeEqual } = require('node:crypto')

const CREATOR_STUDIO_REPAIR_HEADER = 'x-openpet-creator-studio-repair-token'
const CREATOR_STUDIO_REPAIR_FRAGMENT = 'openpet-repair-token'

const deriveCreatorStudioRepairToken = (sessionToken) => sessionToken
  ? createHmac('sha256', sessionToken).update('openpet.creator-studio/dashboard-repair/v1').digest('base64url')
  : ''

const creatorStudioRepairAuthFailure = (candidate, expected) => {
  const error = 'Open Creator Studio from OpenPet to authorize repairs'
  if (typeof candidate !== 'string' || !candidate) return { status: 401, error }
  const supplied = Buffer.from(candidate)
  if (!expected || supplied.length !== Buffer.byteLength(expected) || !timingSafeEqual(supplied, Buffer.from(expected))) {
    return { status: 403, error }
  }
  return null
}

module.exports = { CREATOR_STUDIO_REPAIR_HEADER, CREATOR_STUDIO_REPAIR_FRAGMENT, deriveCreatorStudioRepairToken, creatorStudioRepairAuthFailure }

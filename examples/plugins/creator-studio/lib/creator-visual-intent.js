const MAX_BRIEF_LENGTH = 512

const VIEWER_SIDES = Object.freeze(['viewer-left', 'viewer-right'])

const STYLE_PREFERENCES = Object.freeze({
  tone: Object.freeze({
    warm: 'a subtly warmer color balance within the existing palette',
    cool: 'a subtly cooler color balance within the existing palette'
  }),
  mood: Object.freeze({
    friendly: 'a gentle, approachable expression',
    calm: 'a relaxed expression',
    cheerful: 'a subtly cheerful expression',
    focused: 'an attentive, focused expression'
  })
})

const NEGATION = /\b(?:instead|never|not|no|avoid|remove|replace)\b|改成|不要|不用|不得|不[向往朝]|别[向往朝]|禁止|避免|移除|删除|刪除/u
const AFFIRMATIVE_RESTART = /^\s*(?:\b(?:(?:but\s+)?(?:use|try|prefer|just|please))\b|改用|改做|只要|只做|请|請)/u

const positiveClauses = (segment) => {
  const positive = []
  let inNegativeList = false
  for (const clause of segment.split(/[,，、]+/)) {
    if (inNegativeList && !AFFIRMATIVE_RESTART.test(clause)) continue
    const [head, negativeSuffix] = clause.split(/\bwithout\b|同时不|同時不/u, 2)
    const negated = NEGATION.test(head)
    if (!negated && head.trim()) positive.push(head.trim())
    inNegativeList = negated || negativeSuffix !== undefined
  }
  return positive
}

// Only matched enum values or code-owned motion descriptions reach model prompts.
const briefClauses = (value) => String(value || '').slice(0, MAX_BRIEF_LENGTH)
  .normalize('NFKC')
  .slice(0, MAX_BRIEF_LENGTH)
  .toLowerCase()
  .split(/[\r\n.!?。！？]+/)
  .filter((sentence) => !/\b(?:ignore|disregard|override|system prompt|instructions?)\b|忽略|无视|無視|覆盖|覆蓋|提示[词詞]|指令/u.test(sentence))
  .flatMap((sentence) => sentence.split(/[;；]+/).flatMap(positiveClauses))

const chooseUnambiguous = (clauses, options) => {
  const matches = Object.entries(options).filter(([, pattern]) => clauses.some((clause) => pattern.test(clause)))
  return matches.length === 1 ? matches[0][0] : undefined
}

const extractStylePreferences = (brief) => {
  const clauses = briefClauses(brief)
  const tone = chooseUnambiguous(clauses, {
    warm: /\b(?:warm|warmer)\b|暖[色调調光]|偏暖|暖感/u,
    cool: /\b(?:cool|cooler)(?=[ -]+(?:tones?|colou?r|palette|light|hues?))|冷[色调調光]|偏冷/u
  })
  const mood = chooseUnambiguous(clauses, {
    friendly: /\b(?:friendly|gentle|approachable)\b|友善|友好|温柔|溫柔|亲切|親切/u,
    calm: /\b(?:calm|relaxed|serene|peaceful)\b|平静|平靜|沉静|沉靜|放松|放鬆|安静|安靜/u,
    cheerful: /\b(?:cheerful|happy|playful|joyful)\b|开朗|開朗|愉快|俏皮|活泼|活潑/u,
    focused: /\b(?:focused|attentive)\b|专注|專注/u
  })
  return { ...(tone ? { tone } : {}), ...(mood ? { mood } : {}) }
}

const extractMorphologyHint = (brief) => chooseUnambiguous(briefClauses(brief), {
  'grounded-compact-character': /\bcompact\b|紧凑|緊湊|短胖/u,
  'grounded-elongated-character': /\b(?:elongated|long[- ]bodied)\b|细长|細長|长条|長條/u,
  'floating-character': /\b(?:floating|hovering)\b|悬浮|懸浮|漂浮/u
}) || ''

const SIDE_TERMS = Object.freeze({
  'viewer-left': /\b(?:left|leftward)\b|左/u,
  'viewer-right': /\b(?:right|rightward)\b|右/u
})

const MOTIONS = [
  ['Waving', /\bwav(?:e|es|ed|ing)\b|挥手|揮手|挥爪|揮爪|招手/u, 'stationary_loop', 'wave one visible appendage in greeting', 'selected visible waving appendage'],
  ['Blinking', /\bblink(?:s|ed|ing)?\b|眨眼/u, 'stationary_loop', 'close and reopen the eyes once', 'eyelids'],
  ['Locomotion', /\b(?:walk(?:s|ing)?|running|runs?|sprint(?:s|ing)?|trot(?:s|ting)?|crawl(?:s|ing)?|fly(?:ing)?)\b|走路|行走|跑|爬行|飞|飛/u, 'locomotion_loop', 'take successive strides in place', 'visible locomotion appendages'],
  ['Jumping', /\b(?:jump(?:s|ing)?|hops?|hopping|bounc(?:e|ing))\b|跳|蹦/u, 'vertical_bounce', 'jump and land on the original baseline', 'whole body'],
  ['Spinning', /\b(?:spin(?:s|ning)?|twirl(?:s|ing)?|turn(?:s|ing)? around)\b|转圈|轉圈|旋转|旋轉/u, 'reaction', 'turn in place around the fixed body root', 'whole-body turn'],
  ['Eye roll', /\b(?:roll(?:s|ed|ing)? (?:(?:its|their|the) )?eyes|eye[ -]roll(?:s|ing)?)\b|翻白眼|翻眼睛/u, 'emote', 'briefly roll the visible eyes upward while keeping the body still', 'visible eyes'],
  ['Roll in place', /\broll(?:s|ed|ing)? (?:over|around|in place)\b|^(?:please\s+)?roll(?:\s+(?:gently|slowly|quickly))?$|打滚|打滾|翻滚|翻滾/u, 'reaction', 'roll in place and recover without drifting', 'whole-body roll'],
  ['Nodding', /\bnod(?:s|ding)?\b|点头|點頭/u, 'reaction', 'dip and lift the head in a nod', 'head tilt'],
  ['Head shake', /\bshak(?:e|es|ing) (?:its |the )?head\b|摇头|搖頭/u, 'reaction', 'shake the head gently from side to side', 'head tilt'],
  ['Stretching', /\bstretch(?:es|ing)?\b|伸懒腰|伸懶腰|伸展/u, 'pose_transition', 'stretch the visible limbs without changing body size', 'visible limbs'],
  ['Sitting', /\bsit(?:s|ting)?\b|坐下|坐着|坐著/u, 'pose_transition', 'lower into a seated pose', 'visible support limbs and body'],
  ['Lying down', /\b(?:lie[ -]down|lying[ -]down|sleep(?:s|ing)?)\b|躺下|趴下|睡觉|睡覺/u, 'pose_transition', 'settle into a low resting pose', 'visible support limbs and body'],
  ['Standing', /\b(?:stand(?:s|ing)?|wak(?:e|es|ing))\b|站起|起身|醒/u, 'pose_transition', 'rise to the normal standing pose', 'visible support limbs and body'],
  ['Tail wag', /\b(?:wag(?:s|ging)?|(?:swish(?:es|ing)?|flick(?:s|ing)?) (?:its |the )?tail)\b|摇尾|搖尾|甩尾/u, 'stationary_loop', 'wag the existing visible tail', 'visible tail'],
  ['Smile', /\b(?:smil(?:e|es|ing)|grin(?:s|ning)?|laugh(?:s|ing)?)\b|笑/u, 'emote', 'form a readable smile', 'visible expressive features required by the emote'],
  ['Surprised reaction', /\b(?:surpris(?:e|ed)|startl(?:e|ed)|flinch(?:es|ing)?)\b|惊讶|驚訝|吓|嚇/u, 'reaction', 'show a brief startled reaction', 'visible parts required to communicate the reaction'],
  ['Idle', /\b(?:idle|rest(?:s|ing)?)\b|待机|待機|空闲|空閒/u, 'stationary_loop', 'stay in the canonical resting pose', 'eyelids']
]

const GENERIC_EMOTE = ['Emote', /\b(?:emote|emoji|expression|sparkle)\b|表情/u, 'emote', 'show the expression using existing facial features only', 'visible expressive features required by the emote']

const parseMotionBrief = (value) => {
  const primary = []
  const facing = []
  for (const clause of briefClauses(value)) {
    const [main, context] = clause.replace(/\s+/g, ' ').split(/(?<!\ba )\bwhile\b|同时|同時/u, 2)
    if (main.trim()) primary.push(main.trim())
    if (/^\s*(?:facing\b|面向|朝向|面朝)/u.test(context || '')) facing.push(context.trim())
  }
  return { primary, facing }
}

const findMotion = (clauses) => {
  for (const clause of clauses) {
    const match = MOTIONS.map((motion) => ({ motion, index: clause.search(motion[1]) }))
      .filter(({ index }) => index >= 0)
      .sort((left, right) => left.index - right.index)[0]
    if (match) return match.motion
  }
  return clauses.some((clause) => GENERIC_EMOTE[1].test(clause)) ? GENERIC_EMOTE : null
}

const toProviderAction = (action = {}) => {
  const descriptionBrief = parseMotionBrief(action.motionPrompt)
  const titleBrief = parseMotionBrief(action.name)
  const [name, , animationType, moment, movingPart] = findMotion(descriptionBrief.primary) || findMotion(titleBrief.primary) ||
    ['Custom action', null, action.loop ? 'stationary_loop' : 'reaction', 'show a small anchored reaction', 'visible expressive features']
  const sideClauses = ({ primary, facing }) => animationType === 'locomotion_loop' ? [...primary, ...facing] : primary
  const descriptionSides = sideClauses(descriptionBrief)
  const hasSideInDescription = Object.values(SIDE_TERMS).some((pattern) => descriptionSides.some((clause) => pattern.test(clause)))
  const side = chooseUnambiguous(hasSideInDescription ? descriptionSides : sideClauses(titleBrief), SIDE_TERMS)
  const speed = chooseUnambiguous(descriptionBrief.primary, {
    slowly: /\b(?:slowly|slow|gently|gentle)\b|缓慢|緩慢|慢慢|轻轻|輕輕/u,
    quickly: /\b(?:quickly|quick|fast|rapidly)\b|快速|迅速/u
  })
  const description = speed ? `${moment} ${speed}` : moment
  return {
    ...action,
    name,
    animationType,
    motionPrompt: description,
    ...(animationType === 'locomotion_loop' && side && !action.viewDirection ? { viewDirection: `strict ${side} side profile` } : {}),
    providerMotionDescription: description,
    animatedParts: action.animatedParts?.length ? action.animatedParts : [
      name === 'Waving' && side ? `${side} waving appendage` : movingPart
    ]
  }
}

module.exports = { STYLE_PREFERENCES, VIEWER_SIDES, extractStylePreferences, extractMorphologyHint, toProviderAction }

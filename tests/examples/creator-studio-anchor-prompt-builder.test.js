const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildActionAnchorPrompt,
  buildActionKeyframePrompt,
  buildActionSpriteRowPrompt,
  buildCharacterAnchorPrompt
} = require('../../examples/plugins/creator-studio/lib/anchor-prompt-builder')
const { createProviderImageTask } = require('../../examples/plugins/creator-studio/lib/provider-image-task')

const assertProviderNeutral = (prompt) => {
  assert.doesNotMatch(prompt, /\bOpenPet\b/i)
  assert.doesNotMatch(prompt, /\bProvider\b/i)
  assert.doesNotMatch(prompt, /\bbackend\b/i)
  assert.doesNotMatch(prompt, /\b(?:run|action)[-_ ]?id\b/i)
  assert.doesNotMatch(prompt, /\breference[-_ ]?role\b/i)
  assert.doesNotMatch(prompt, /\bcheckpoint\b/i)
  assert.doesNotMatch(prompt, /\bmultipart\b/i)
  assert.doesNotMatch(prompt, /(?:\/Users|\/var|\/tmp|\/private|\/Volumes)\//i)
}

test('quality-first frame-sheet image task uses square canvas and strict action policies', () => {
  const task = createProviderImageTask({
    taskType: 'action-frame-sheet',
    stage: 'final',
    sheet: { frameCount: 8, columns: 4, rows: 2 },
    referenceRole: 'action-anchor-grid',
    action: { name: 'in-place gait', moment: 'alternating contact cycle', movingParts: ['locomotion limbs'], lockedParts: ['identity'], loopIntent: 'closed loop', framePlan: ['contact', 'down', 'passing', 'up', 'opposite contact', 'opposite down', 'opposite passing', 'loop close'] },
    actionClass: 'grounded-locomotion',
    anchorPolicy: 'compact-contact-root-v1',
    componentPolicy: 'reference-guided-body-v1',
    effectPolicy: 'forbid-detached-effects',
    motionPresetId: 'running-right-gait-v1',
    framePlanVersion: 1
  })

  assert.deepEqual(task.canvas, { width: 1024, height: 1024, aspectRatio: '1:1' })
  assert.equal(task.actionClass, 'grounded-locomotion')
  assert.equal(task.anchorPolicy, 'compact-contact-root-v1')
  assert.equal(task.componentPolicy, 'reference-guided-body-v1')
  assert.equal(task.effectPolicy, 'forbid-detached-effects')
  assert.equal(task.motionPresetId, 'running-right-gait-v1')
  assert.equal(task.framePlanVersion, 1)
})

test('quality-first frame-sheet prompt keeps strict policy evidence and gpt image 2 capabilities', () => {
  const result = buildActionSpriteRowPrompt({
    model: 'gpt-image-2',
    referenceRole: 'action-reference-board',
    action: {
      actionId: 'running-right',
      name: 'running right',
      animationType: 'locomotion_loop',
      frameCount: 8,
      actionClass: 'grounded-locomotion',
      anchorPolicy: 'compact-contact-root-v1',
      componentPolicy: 'reference-guided-body-v1',
      effectPolicy: 'forbid-detached-effects',
      motionPresetId: 'running-right-gait-v1',
      framePlanVersion: 1
    }
  })

  assert.equal(result.promptCompiler.modelCapabilityProfile, 'gpt-image-2-v1')
  assert.equal(result.promptCompiler.backgroundStrategy, 'solid-background-then-local-removal')
  assert.equal(result.promptCompiler.actionClass, 'grounded-locomotion')
  assert.equal(result.promptCompiler.anchorPolicy, 'compact-contact-root-v1')
  assert.equal(result.promptCompiler.componentPolicy, 'reference-guided-body-v1')
  assert.equal(result.promptCompiler.effectPolicy, 'forbid-detached-effects')
  assert.equal(result.promptCompiler.motionPresetId, 'running-right-gait-v1')
  assert.equal(result.promptCompiler.framePlanVersion, 1)
  assert.doesNotMatch(result.prompt, /transparent/i)
})

test('quality-first frame-sheet rejects a non-square provider canvas', () => {
  assert.throws(() => createProviderImageTask({
    taskType: 'action-frame-sheet',
    stage: 'final',
    canvas: { width: 1536, height: 1024 },
    sheet: { frameCount: 8, columns: 4, rows: 2 },
    action: { name: 'gait', framePlan: Array.from({ length: 8 }, (_, index) => `frame ${index + 1}`) },
    actionClass: 'grounded-locomotion',
    anchorPolicy: 'compact-contact-root-v1',
    componentPolicy: 'reference-guided-body-v1',
    effectPolicy: 'forbid-detached-effects',
    motionPresetId: 'running-right-gait-v1',
    framePlanVersion: 1
  }), (error) => error?.code === 'image_prompt_contract_invalid' && /square 1024/i.test(error.message))
})

test('character anchor prompt is self-contained and reference authoritative', () => {
  const result = buildCharacterAnchorPrompt({ referenceRole: 'composite-reference-board' })
  assert.equal(result.role, 'character-anchor')
  assert.equal(result.version, 6)
  assert.equal(result.promptCompilerVersion, 3)
  assert.equal(result.promptCompiler.visualPlanVersion, 1)
  assert.equal(result.promptCompiler.providerImageTaskVersion, 3)
  assert.equal(result.promptCompiler.promptRenderer, 'gpt-image-2-v1')
  assert.equal(result.promptCompiler.modelCapabilityProfile, 'gpt-image-2-v1')
  assert.equal(result.promptCompiler.backgroundStrategy, 'solid-background-then-local-removal')
  assert.match(result.prompt, /^DELIVERABLE\nCreate one complete full-body character image at 1024 x 1024 with a 1:1 aspect ratio\./)
  assert.match(result.prompt, /main identity view controls canonical continuity/i)
  assert.match(result.prompt, /every identity-bearing feature.*every body part or accessory visible/is)
  assert.match(result.prompt, /uniform opaque background color/i)
  assert.doesNotMatch(result.prompt, /transparent/i)
  assertProviderNeutral(result.prompt)
})

test('action anchor prompt keeps identity while describing only visible motion', () => {
  const result = buildActionAnchorPrompt({
    referenceRole: 'source-action-reference-board',
    action: { actionId: 'waving', name: 'Waving', motionPrompt: 'Raise the viewer-right front paw and wave gently.', animationType: 'stationary_loop', animatedParts: ['viewer-right front paw'], lockedParts: ['head', 'torso', 'feet/base'] }
  })
  assert.equal(result.role, 'action-anchor')
  assert.equal(result.actionId, 'waving')
  assert.match(result.prompt, /Change only the pose to this exact visible moment/i)
  assert.match(result.prompt, /selected visible waving appendage/i)
  assert.match(result.prompt, /head, torso, feet\/base/i)
  assert.match(result.prompt, /complete full-body action keyframe/i)
  assert.match(result.prompt, /ACTION PLAN/i)
  assertProviderNeutral(result.prompt)
})

test('canonical prompts preserve visible source accessories', () => {
  const result = buildActionSpriteRowPrompt({ action: { actionId: 'waving', name: 'Waving', motionPrompt: 'Wave one front paw.', frameCount: 4 } })
  assert.match(result.prompt, /same visible accessories or garments when present/i)
  assert.match(result.prompt, /Do not invent, remove, duplicate, or redesign visible anatomy or accessories/i)
  assertProviderNeutral(result.prompt)
})

test('action sprite row prompt defines an exact reference-conditioned frame sheet', () => {
  const result = buildActionSpriteRowPrompt({
    referenceRole: 'keyframe-action-reference-board',
    action: { actionId: 'waving', name: 'Waving', motionPrompt: 'Raise the viewer-right front paw and wave gently.', animationType: 'stationary_loop', frameCount: 6, animatedParts: ['viewer-right front paw'], lockedParts: ['head', 'torso', 'feet/base'] }
  })
  assert.equal(result.role, 'action-sprite-row')
  assert.equal(result.frameCount, 6)
  assert.match(result.prompt, /^DELIVERABLE\nCreate one complete animation frame sheet for Waving at 1536 x 1024 with exactly 6 complete full-body character frames arranged in 3 columns and 2 rows\./)
  assert.match(result.prompt, /use the pose examples for the starting pose, motion direction, and motion extreme/i)
  assert.match(result.prompt, /Read cells left to right, then top to bottom/i)
  assert.match(result.prompt, /Cell 1 \(row 1 column 1\).*neutral anchored pose/is)
  assert.match(result.prompt, /Cell 3 \(row 1 column 3\).*greeting pose/is)
  assert.match(result.prompt, /Cell 6 \(row 2 column 3\).*starting pose/is)
  assert.match(result.prompt, /same viewpoint, character scale, subject lighting, and lower-center root/i)
  assert.match(result.prompt, /uniform opaque background color/i)
  assert.doesNotMatch(result.prompt, /\.\./)
  assert.doesNotMatch(result.prompt, /transparent/i)
  assertProviderNeutral(result.prompt)
})

test('action keyframe prompts create separate start and peak images', () => {
  const action = { actionId: 'waving', name: 'Waving', motionPrompt: 'Wave with one front paw.', frameCount: 6 }
  const start = buildActionKeyframePrompt({ keyframeRole: 'start', action })
  const peak = buildActionKeyframePrompt({ keyframeRole: 'peak', action })
  assert.equal(start.keyframeRole, 'start')
  assert.equal(peak.keyframeRole, 'peak')
  assert.match(start.prompt, /full-body neutral pose with the body anchored/i)
  assert.match(peak.prompt, /selected visible waving appendage clearly changed from neutral and fully raised/i)
  assert.match(start.prompt, /uniform opaque background color/i)
  assert.match(peak.prompt, /uniform opaque background color/i)
  assert.doesNotMatch(start.prompt, /transparent/i)
  assert.doesNotMatch(peak.prompt, /transparent/i)
  assertProviderNeutral(start.prompt)
  assertProviderNeutral(peak.prompt)
})

test('directional gait keyframes can rotate the identity reference without forcing front-visible features', () => {
  for (const referenceRole of ['canonical-reference', 'full-pet-action-identity-board']) {
    const { prompt } = buildActionKeyframePrompt({
      referenceRole,
      qualityGuidance: { reasonCounts: { 'identity-drift': 1 } },
      action: { actionId: 'running-right', animationType: 'locomotion_loop', viewDirection: 'strict right-facing side view' }
    })
    assert.match(prompt, /ACTION PLAN controls the pose and viewing direction/i)
    assert.match(prompt, /natural foreshortening and self-occlusion/i)
    assert.doesNotMatch(prompt, /same body proportions and silhouette/i)
    assert.doesNotMatch(prompt, /exact species, silhouette/i)
    assert.doesNotMatch(prompt, /every body part or accessory visible in the reference present/i)
    assertProviderNeutral(prompt)
  }
})

test('running keyframes make the contact feet visible enough to condition the video gait', () => {
  const { prompt } = buildActionKeyframePrompt({
    action: { actionId: 'running-right', animationType: 'locomotion_loop', viewDirection: 'strict right-facing side view' },
    keyframeRole: 'start'
  })
  assert.match(prompt, /both locomotion legs and feet clearly visible and separated/i)
  assert.match(prompt, /one foot planted under the body/i)
})

test('sparse wave metadata still produces a complete moving-part contract', () => {
  const result = buildActionSpriteRowPrompt({ action: { actionId: 'dev8-provider-row-wave', motionPrompt: 'One front paw waves beside the face.', frameCount: 6 } })
  assert.match(result.prompt, /Primary motion: the selected visible waving appendage/i)
  assert.match(result.prompt, /seamless stationary loop with a stable body root/i)
  assert.doesNotMatch(result.prompt, /the requested moving part/i)
  assertProviderNeutral(result.prompt)
})

test('four-frame wave plans close the loop by returning to the start pose', () => {
  const result = buildActionSpriteRowPrompt({ action: { actionId: 'waving', motionPrompt: 'Wave one front paw and return to idle.', frameCount: 4, loop: true } })
  assert.match(result.prompt, /Cell 3 .*wave peak/is)
  assert.match(result.prompt, /Cell 4 .*return.*starting pose/is)
  assert.doesNotMatch(result.prompt, /Cell 4 .*tilts slightly outward/is)
})

test('directional one-shot gait requests a clear stop, not a seamless loop', () => {
  const action = {
    actionId: 'quick-jog', motionPrompt: 'Jog in place.', animationType: 'locomotion_loop', frameCount: 6,
    actionContract: { loop: false, facing: 'viewer-left', camera: 'locked' }
  }
  const { prompt } = buildActionSpriteRowPrompt({ action })
  assert.match(prompt, /face toward the left edge of the image as seen by the viewer/i)
  assert.match(prompt, /camera motion, pan, zoom, or rotation/i)
  assert.match(prompt, /cell 6.*supported stopping pose/i)
  assert.match(prompt, /play once with a clear ending pose/i)
  assert.doesNotMatch(prompt, /seamless|loop-closing/i)

  const looping = { ...action, actionContract: { ...action.actionContract, loop: true, facing: 'viewer-right' } }
  assert.match(buildActionKeyframePrompt({ action: looping, keyframeRole: 'start' }).prompt, /face toward the right edge of the image as seen by the viewer/i)
  assert.match(buildActionSpriteRowPrompt({ action: looping }).prompt, /seamless in-place locomotion cycle/i)
})

test('16-frame one-shot gait and idle sheets never blend in a loop-closing beat', () => {
  for (const [name, lastPose] of [
    ['Running gait', /supported stopping pose/i],
    ['Idle blink', /settled pose without restarting the motion/i]
  ]) {
    const action = { name, frameCount: 16, actionContract: { loop: false, facing: 'reference', camera: 'locked' } }
    const { prompt } = buildActionSpriteRowPrompt({ action })
    assert.doesNotMatch(prompt, /seamless|loop.closing|wraparound transition that/i)
    assert.match(prompt.split('\n').find((line) => /cell 16\b/i.test(line)), lastPose)
  }
})

test('one-shot plans keep custom poses that happen to use loop-related words', () => {
  const pose = 'raised paw with a seamless sleeve cuff'
  const { prompt } = buildActionSpriteRowPrompt({
    action: {
      name: 'Lift a paw', frameCount: 6, loop: false,
      framePlan: ['neutral stance', pose]
    }
  })
  assert.match(prompt, new RegExp(pose))
  assert.match(prompt.split('\n').find((line) => /cell 6\b/i.test(line)), /settled pose without restarting the motion/i)
})

test('a full custom one-shot plan keeps one pose per cell and settles in its requested last pose', () => {
  const framePlan = ['paw planted', 'paw lifting', 'paw raised beside the face', 'paw lowered with eyes open']
  const { prompt } = buildActionSpriteRowPrompt({
    action: { name: 'Lift a paw', frameCount: framePlan.length, loop: false, framePlan }
  })
  const cells = prompt.split('\n').filter((line) => /^cell \d+\b/i.test(line))
  assert.deepEqual(cells.map((line) => line.split(' — ')[1]), framePlan.map((pose) => `${pose}.`))
  assert.match(prompt, /hold the last requested pose as the settled ending/i)
})

test('one-shot playback wording does not consume the custom pose length budget', () => {
  const pose = 'Raise the left paw beside the face, with the wrist bent slightly inward and the elbow relaxed. Keep the shoulders level, the gaze straight ahead, both feet flat on the ground, and the tail lowered. Keep the three paw pads clearly visible'
  assert.ok(pose.length > 220 && pose.length < 240)
  const { prompt } = buildActionSpriteRowPrompt({
    action: { name: 'Lift a paw', frameCount: 4, loop: false, framePlan: ['neutral stance', pose] }
  })
  const cell = prompt.split('\n').find((line) => /^Cell 3\b/.test(line))
  assert.equal(cell.split(' — ')[1], `${pose}.`)
  assert.match(prompt, /^.*Loop requirement:.*use each cell description as a visual pose only.*without restarting the motion.*$/im)
})

test('a custom one-shot gait uses custom text as pose reference, not as playback instructions', () => {
  const pose = 'start the next stride by raising the left foot'
  const { prompt } = buildActionSpriteRowPrompt({
    action: {
      name: 'Running gait', frameCount: 6, loop: false,
      framePlan: ['first contact with the right foot planted', pose]
    }
  })
  const cells = prompt.split('\n').filter((line) => /^cell \d+\b/i.test(line))
  assert.equal(cells.length, 6)
  assert.match(prompt, /^.*Loop requirement:.*use each cell description as a visual pose only.*without restarting the motion.*$/im)
  assert.ok(cells.some((line) => line.includes(pose)))
  assert.match(cells.at(-1), /supported stopping pose/i)
  assert.doesNotMatch(cells.at(-1), /start the next stride/i)
})

test('idle blink uses the specified facing for its start, peak, and loop return', () => {
  const action = {
    actionId: 'idle', name: 'Idle blink', frameCount: 5,
    actionContract: { loop: true, facing: 'viewer-left', camera: 'locked' }
  }
  const { prompt } = buildActionSpriteRowPrompt({ action })
  assert.match(prompt, /face toward the left edge/i)
  assert.match(prompt, /cell 1[^\n]*quiet reference pose from the specified facing/i)
  assert.match(prompt, /cell 5[^\n]*starting pose in the specified facing/i)
  assert.doesNotMatch(prompt, /canonical identity pose, viewpoint/i)
  assert.match(buildActionKeyframePrompt({ action, keyframeRole: 'peak' }).prompt, /silhouette in the specified facing/i)
})

test('official running metadata produces a complete stationary work-state cycle', () => {
  const result = buildActionSpriteRowPrompt({ action: { actionId: 'running', name: 'Running', motionPrompt: 'Active processing and scanning motion.', frameCount: 8 } })
  assert.match(result.prompt, /seamless stationary loop with a stable body root/i)
  assert.match(result.prompt, /processing|scanning|focused work-state/i)
  assert.match(result.prompt, /visible attention features/i)
  assert.doesNotMatch(result.prompt, /locomotion|gait|contact pose|passing pose/i)
  assertProviderNeutral(result.prompt)
})

test('action identity takes precedence over incidental motion words', () => {
  const waving = buildActionSpriteRowPrompt({ action: { actionId: 'waving', name: 'Waving', motionPrompt: 'Stand still and wave one front paw.', frameCount: 4 } })
  const jumping = buildActionKeyframePrompt({ keyframeRole: 'peak', action: { actionId: 'jumping', name: 'Jumping', motionPrompt: 'Take a short running start, jump upward, then land.', frameCount: 5 } })
  assert.match(waving.prompt, /seamless stationary loop with a stable body root/i)
  assert.match(waving.prompt, /selected visible waving appendage/i)
  assert.match(jumping.prompt, /airborne peak/i)
  assert.match(jumping.prompt, /return to the same baseline/i)
  assertProviderNeutral(waving.prompt)
  assertProviderNeutral(jumping.prompt)
})

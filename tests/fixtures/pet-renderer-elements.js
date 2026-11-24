const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '../../apps/desktop/index.html'), 'utf8')
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id)

const createPetRendererElements = (createElement) => Object.fromEntries(ids.map((id) => [id, createElement(id)]))

module.exports = { createPetRendererElements }

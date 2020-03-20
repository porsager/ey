const postgres = require('postgres')

const db = postgres({
  database: 'ey-example-rest'
})

module.exports = db

db`
  create table if not exists things (
    id serial primary key,
    name text,
    color text
  )
`.catch(console.error)

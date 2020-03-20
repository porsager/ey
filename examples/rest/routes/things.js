const ey = require('../../../')
    , sql = require('../db')
    , bodyParser = require('body-parser')

const route = module.exports = ey()

route.use(bodyParser.json())
route.use(ey.async)

route.get('/', () => sql`
  select * from things
`)

route.get('/:id', (req) => sql`
  select * from things where id = ${ req.params.id }
`.then(([x]) => x))

route.post('/', (req) => sql`
  insert into things ${ sql(req.body) }
  returning *
`.then(([x]) => x))

route.put('/:id', (req) => sql`
  update things set ${ sql(req.body) } where id = ${ req.params.id }
  returning *
`.then(([x]) => x))

route.delete('/:id', (req) => sql`
  delete from things where id = ${ req.params.id }
  returning *
`.then(([x]) => x))

route.use(ey.await((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.body
    .then(x => {
      res.statusCode = x ? 200 : 404
      res.end(JSON.stringify(x || 'Not Found'))
    })
    .catch(err => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
      console.error(err)
    })
}))

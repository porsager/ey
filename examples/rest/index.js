const ey = require('../../')
    , http = require('http')
    , things = require('./things')

const route = ey()

/*
route.use(log)
route.use(auth)
*/

route.use('/things', things)

/*
route.use('/users', users)
route.use('/groups', groups)
route.use('/etc', etc)
*/

route.use((req, res) => {
  res.statusCode = 404
  res.end('Not Found')
})

const server = http.createServer(route)

server.listen(3000)

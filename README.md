# Ey

Ey is an ergonomic and fast server+router, built on [uWebSockets](https://github.com/uNetworking/uWebSockets.js) (for now). It has a simple interface embracing todays JS features.

## Getting Started

```javascript
import ey from 'ey'

const app = ey()

app.get('/', r => r.end('Hello World'))

const { port } = await app.listen(process.env.PORT)
```

## The request

The request object contains all relavant data and methods to handle incoming requests and methods to respond as desired.

```javascript
app.get(r => {
    r // is the request object
})
```

### Incoming

#### `.method`
The HTTP verb of the request.

#### `.url`
Contains the actual url sent by the client

#### `.pathname`
Contains the relative url for the specific handler

#### `.headers`
An object containing headers. If multiple headers are found the value will be a comma separated list of values.

#### `.query`
A URLSearchParams object for the query string. This is a getter so the URLSearchParams object will be created lazily.

#### `.params`
An object of the matched routing params like.
`/authors/:author/books/:book` = `{ author: 'Murray', book: 'Ethics of Liberty' }`

#### `.body() -> Promise`
A function which reads the incoming body and transforms it to an optional type `text` or `json`. If no type is specificed a `Buffer` will be returned.

#### `r.cookie(name) -> Object`
Returns an object representing the cookie


### Outgoing

#### `.end(body, [status], [headers])`

#### `.head([status], [headers], [cork_last])`

#### `.set(header, value) | r.set({ header: value })`

#### `.write()`

#### `.cork()`

#### `.offset()`

#### `.status()`

#### `.writable()`

#### `.close()`

#### `.cookie(name, { ... })`

### Middleware

Implement middleware with `all`. Ey forwards the request to the next handler, unless a response has begun.

```javascript
app.all((r, next) => {
  r.headers.authorization
    ? r.token = r.headers.authorization.split(' ')[1]
    : r.end(401) // request ends here
})

app.all(r => {
    r.token
})
```

### Optimizations

There are various ways to optimize your routes by being more specific in their definition.

#### Pre-specified request headers
You can specify which headers a route will use, up front, to prevent reading and loading unnecessary headers. Be aware that this is not possible for route handlers that come after other async handlers.

```javascript
const app = ey({ headers: ['content-type'] })

app.get('/login', { headers: ['authorization'] }, r => {
  r.headers['content-type'] // string
  r.headers['authorization'] // string
  r.headers['accept'] // undefined    
})
```

### Error handling

Any middleware that accepts 2 arguments will be registrered as an error handler and receive the error as the first argument, and the request object as the second. This will allow you to log errors and reply accordingly. If no error handler makes a response the default error handler will reply with `500 Internal Server Error` and call `console.error`.

```javascript
app.all((error, r) => {
  connected = true
  res.end(await ...)
})
```

### Route matching
Routes are matched according to the order in which they are defined. This is important to support middleware with less specific route matching.

#### Exact match
| hej | med | yo |
| -- | -- | -- |
| ```/user``` | will only match requests to the url `/user` | |

#### Wildcard (not implemented yet)
```/user*``` All requests that begins with `/user`
```/user/*``` All requests that begins with `/user/`
```*/user``` All requests that ends with `/user`


#### Parameters
##### ```/user``` 
> All requests with one path segment, setting `r.params = { user }`


##### ```/:user/posts/:post```
> All requests with 3 segments that has `posts` in the middle, setting `r.params = { user, post }`


#### Regex


## Examples

### Get


### Get with Params

```javascript
// GET /u25
app.get('/:id', r => 
  r.params.id // The actual id value
)
```

### Get query params
```javascript
// GET /?sort=-price
app.get(r => {
  req.query.sort // -price
})
```


### Getting posted JSON

```javascript
// POST /user { name: 'Murray' }
app.post('/user', async r => {
  const body = await r.body('json')
      , user = await sql`insert into users ${ sql(body) }`
      
  r.json(user, 201) // r.json sets Content-Type: application/json header
})
```

### Send file
```javascript
app.get('/favicon.ico', r => r.file('/public/favicon.ico'))
```

### Serve files
```javascript
app.all('/node_modules', r.files('/node_modules'))
```


### File upload
```javascript
// POST /file data
app.post('/file', async r => {
  await new Promise((resolve, reject) =>
    r.readable.pipe(fs.createWriteStream('...'))
     .on('finish', resolve)
     .on('error', reject)
  )
  r.end('Done')
})
```

### Redirect
```javascript
// GET /old-link
app.get('/old-link', async r => {
  r.end(302, {
    location: '/new-link'
  })
})
```

### Auth

```javascript
app.all(r => {
  const session = await sql`select * from sessions where key = ${ 
    r.headers.authorization.split(' ')[0] 
  }`  
})
```


## The request object


## Routing

Ey simplifies the express routing model, by removing `request` and `next`.



```js

```

## WebSockets


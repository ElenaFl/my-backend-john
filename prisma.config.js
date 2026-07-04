import { defineConfig } from '@prisma/config'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { createClient } from '@libsql/client'

const client = createClient({ url: 'file:./prisma/dev.db' })
const adapter = new PrismaLibSql(client)

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    seed: 'node ./prisma/seed.js'
  },
  datasource: {
    provider: 'libsql',
    adapter
  }
})
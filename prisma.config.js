import { defineConfig } from '@prisma/config'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { createClient } from '@libsql/client'

// Берем путь из переменной окружения Amvera, либо используем локальный
const dbUrl = process.env.DATABASE_URL || 'file:./prisma/dev.db'

const client = createClient({ url: dbUrl })
const adapter = new PrismaLibSql(client)

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    seed: 'node ./prisma/seed.js'
  },
  datasource: {
    provider: 'libsql',
    url: dbUrl, // Передаем строку url для CLI Prisma, чтобы сборщик не падал
    adapter
  }
})
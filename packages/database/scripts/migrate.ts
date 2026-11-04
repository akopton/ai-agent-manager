import { applyMigrations, createDatabase } from '../src/index.js';

const connection = createDatabase();
try {
  applyMigrations(connection);
  console.log(`Migrations applied to ${connection.path}`);
} finally {
  connection.close();
}

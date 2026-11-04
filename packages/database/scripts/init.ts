import { createDatabase } from '../src/index.js';

const connection = createDatabase();
try {
  console.log(`SQLite initialized at ${connection.path}`);
} finally {
  connection.close();
}

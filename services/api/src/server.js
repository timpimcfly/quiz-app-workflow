import express from "express";
import pg from "pg";

const { Pool } = pg;

const app = express();
const port = Number(process.env.API_PORT || 4000);
const databaseUrl = process.env.DATABASE_URL;
const defaultQuizQuestionLimit = Number(process.env.QUIZ_QUESTION_LIMIT || 10);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });

async function ensureHighscoreSchema() {
  await pool.query(`
    ALTER TABLE highscores
    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE highscores
    DROP CONSTRAINT IF EXISTS highscores_duration_seconds_check
  `);

  await pool.query(`
    ALTER TABLE highscores
    ADD CONSTRAINT highscores_duration_seconds_check CHECK (duration_seconds >= 0)
  `);

  await pool.query("DROP INDEX IF EXISTS idx_highscores_ranking");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_highscores_ranking
    ON highscores(topic_id, duration_seconds ASC, created_at ASC)
  `);
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isValidTopicSlug(value) {
  return /^[a-z0-9-]{1,50}$/.test(value);
}

function isNonEmptyString(value, maxLength) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

function shuffleAnswers(questionRow) {
  const options = Array.isArray(questionRow.options) ? questionRow.options : [];
  const indexed = options.map((option, index) => ({
    option,
    originalIndex: index,
  }));

  for (let i = indexed.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = indexed[i];
    indexed[i] = indexed[j];
    indexed[j] = tmp;
  }

  const remappedCorrectIndex = indexed.findIndex(
    (entry) => entry.originalIndex === questionRow.correctIndex,
  );

  return {
    ...questionRow,
    options: indexed.map((entry) => entry.option),
    correctIndex: remappedCorrectIndex,
  };
}

app.use(express.json({ limit: "1mb" }));

app.get(
  "/api/v1/health",
  asyncHandler(async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", db: "up" });
    } catch {
      res.status(503).json({ status: "degraded", db: "down" });
    }
  }),
);

app.get(
  "/api/v1/topics",
  asyncHandler(async (_req, res) => {
    const query = `
    SELECT t.id, t.name, t.description, t.icon, COUNT(q.id)::int AS "questionCount"
    FROM topics t
    LEFT JOIN questions q ON q.topic_id = t.id
    GROUP BY t.id
    ORDER BY name ASC
  `;

    const { rows } = await pool.query(query);
    res.json({ topics: rows });
  }),
);

app.get(
  "/api/v1/topics/:topicId/questions",
  asyncHandler(async (req, res) => {
    const { topicId } = req.params;
    const requestedLimit = req.query.limit
      ? Number(req.query.limit)
      : defaultQuizQuestionLimit;

    if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > 100
    ) {
      res
        .status(400)
        .json({ error: "limit must be an integer between 1 and 100" });
      return;
    }

    const topicQuery = `
    SELECT id, name, description, icon
    FROM topics
    WHERE id = $1
  `;
    const topicResult = await pool.query(topicQuery, [topicId]);

    if (topicResult.rowCount === 0) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }

    const questionsQuery = `
    SELECT id, question_text AS question, options, correct_index AS "correctIndex"
    FROM questions
    WHERE topic_id = $1
    ORDER BY RANDOM()
    LIMIT $2
  `;

    const questionsResult = await pool.query(questionsQuery, [
      topicId,
      requestedLimit,
    ]);

    res.json({
      topic: topicResult.rows[0],
      questions: questionsResult.rows.map(shuffleAnswers),
    });
  }),
);

app.get(
  "/api/v1/highscores",
  asyncHandler(async (req, res) => {
    const { topicId } = req.query;
    const limit = Number(req.query.limit || 10);

    if (!topicId || typeof topicId !== "string") {
      res.status(400).json({ error: "topicId query param is required" });
      return;
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res
        .status(400)
        .json({ error: "limit must be an integer between 1 and 100" });
      return;
    }

    const query = `
    SELECT id, topic_id AS "topicId", player_name AS "playerName", score, total_questions AS "totalQuestions", percentage, duration_seconds AS "durationSeconds", created_at AS "createdAt"
    FROM highscores
    WHERE topic_id = $1
    ORDER BY duration_seconds ASC, created_at ASC
    LIMIT $2
  `;

    const { rows } = await pool.query(query, [topicId, limit]);
    res.json({ highscores: rows });
  }),
);

app.post(
  "/api/v1/highscores",
  asyncHandler(async (req, res) => {
    const {
      topicId,
      playerName,
      score,
      totalQuestions,
      percentage,
      durationSeconds,
    } = req.body;

    if (!topicId || typeof topicId !== "string") {
      res.status(400).json({ error: "topicId is required" });
      return;
    }

    if (
      !playerName ||
      typeof playerName !== "string" ||
      playerName.length > 40
    ) {
      res
        .status(400)
        .json({ error: "playerName is required and must be <= 40 characters" });
      return;
    }

    if (!Number.isInteger(score) || score < 0) {
      res.status(400).json({ error: "score must be an integer >= 0" });
      return;
    }

    if (!Number.isInteger(totalQuestions) || totalQuestions < 1) {
      res.status(400).json({ error: "totalQuestions must be an integer >= 1" });
      return;
    }

    if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
      res
        .status(400)
        .json({ error: "percentage must be an integer between 0 and 100" });
      return;
    }

    if (!Number.isInteger(durationSeconds) || durationSeconds < 0) {
      res
        .status(400)
        .json({ error: "durationSeconds must be an integer >= 0" });
      return;
    }

    const topicExists = await pool.query("SELECT 1 FROM topics WHERE id = $1", [
      topicId,
    ]);
    if (topicExists.rowCount === 0) {
      res.status(400).json({ error: "topicId does not exist" });
      return;
    }

    const insertQuery = `
    INSERT INTO highscores (topic_id, player_name, score, total_questions, percentage, duration_seconds)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, topic_id AS "topicId", player_name AS "playerName", score, total_questions AS "totalQuestions", percentage, duration_seconds AS "durationSeconds", created_at AS "createdAt"
  `;

    const { rows } = await pool.query(insertQuery, [
      topicId,
      playerName.trim(),
      score,
      totalQuestions,
      percentage,
      durationSeconds,
    ]);

    res.status(201).json({ highscore: rows[0] });
  }),
);

app.post(
  "/api/v1/import/questions",
  asyncHandler(async (req, res) => {
    const payload = req.body;
    const topic = payload?.topic;
    const questions = payload?.questions;

    if (!topic || typeof topic !== "object") {
      res.status(400).json({ error: "topic object is required" });
      return;
    }

    if (!Array.isArray(questions) || questions.length < 1) {
      res
        .status(400)
        .json({ error: "questions array with at least one item is required" });
      return;
    }

    const topicId = topic.id;
    const topicName = topic.name;
    const topicDescription = topic.description;
    const topicIcon = topic.icon;

    if (!isValidTopicSlug(topicId)) {
      res
        .status(400)
        .json({ error: "topic.id must be a slug ([a-z0-9-], max 50)" });
      return;
    }

    if (!isNonEmptyString(topicName, 100)) {
      res
        .status(400)
        .json({
          error: "topic.name is required and must be <= 100 characters",
        });
      return;
    }

    if (!isNonEmptyString(topicDescription, 300)) {
      res
        .status(400)
        .json({
          error: "topic.description is required and must be <= 300 characters",
        });
      return;
    }

    if (!isNonEmptyString(topicIcon, 8)) {
      res
        .status(400)
        .json({ error: "topic.icon is required and must be <= 8 characters" });
      return;
    }

    for (let i = 0; i < questions.length; i += 1) {
      const item = questions[i];

      if (!item || typeof item !== "object") {
        res.status(400).json({ error: `questions[${i}] must be an object` });
        return;
      }

      if (!isNonEmptyString(item.question, 300)) {
        res
          .status(400)
          .json({
            error: `questions[${i}].question is required and must be <= 300 characters`,
          });
        return;
      }

      if (
        !Array.isArray(item.options) ||
        item.options.length < 2 ||
        item.options.length > 6
      ) {
        res
          .status(400)
          .json({ error: `questions[${i}].options must contain 2 to 6 items` });
        return;
      }

      const optionsAreValid = item.options.every((option) =>
        isNonEmptyString(option, 120),
      );
      if (!optionsAreValid) {
        res
          .status(400)
          .json({ error: `questions[${i}].options contains invalid values` });
        return;
      }

      if (
        !Number.isInteger(item.correctIndex) ||
        item.correctIndex < 0 ||
        item.correctIndex >= item.options.length
      ) {
        res
          .status(400)
          .json({
            error: `questions[${i}].correctIndex must be an in-range integer`,
          });
        return;
      }
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existingTopic = await client.query(
        "SELECT 1 FROM topics WHERE id = $1",
        [topicId],
      );
      const topicCreated = existingTopic.rowCount === 0;

      await client.query(
        `
        INSERT INTO topics (id, name, description, icon)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id)
        DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          icon = EXCLUDED.icon
      `,
        [topicId, topicName.trim(), topicDescription.trim(), topicIcon.trim()],
      );

      let insertedQuestions = 0;
      let replacedQuestions = 0;

      for (const item of questions) {
        const normalizedQuestion = item.question.trim();
        const normalizedOptions = item.options.map((option) => option.trim());

        const deleteExisting = await client.query(
          `
          DELETE FROM questions
          WHERE topic_id = $1
            AND question_text = $2
            AND options = $3::jsonb
            AND correct_index = $4
          RETURNING id
        `,
          [
            topicId,
            normalizedQuestion,
            JSON.stringify(normalizedOptions),
            item.correctIndex,
          ],
        );

        replacedQuestions += deleteExisting.rowCount;

        await client.query(
          `
          INSERT INTO questions (topic_id, question_text, options, correct_index)
          VALUES ($1, $2, $3::jsonb, $4)
        `,
          [
            topicId,
            normalizedQuestion,
            JSON.stringify(normalizedOptions),
            item.correctIndex,
          ],
        );
        insertedQuestions += 1;
      }

      await client.query("COMMIT");

      res.status(201).json({
        result: {
          topicId,
          topicCreated,
          insertedQuestions,
          replacedQuestions,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  res
    .status(500)
    .json({ error: "Internal server error", details: error.message });
});

async function start() {
  await ensureHighscoreSchema();
  app.listen(port, () => {
    console.log(`quiz-api listening on ${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start quiz-api", error);
  process.exit(1);
});

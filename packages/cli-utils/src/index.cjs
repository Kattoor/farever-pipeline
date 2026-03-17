const { consola: rawConsola } = require('consola');

const PIPELINE_NAME = 'farever-pipeline';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ');
}

function formatPrefix(tag = null) {
  const parts = [`[${formatTimestamp()}]`, `[${PIPELINE_NAME}]`];
  if (tag) parts.push(`[${tag}]`);
  return parts.join(' ');
}

function wrapLogger(tag = null) {
  const emit = (method, message, ...args) => {
    const text = `${formatPrefix(tag)} ${String(message)}`;
    rawConsola[method](text, ...args);
  };

  return {
    withTag(nextTag) {
      return wrapLogger(nextTag);
    },
    start(message, ...args) {
      emit('start', message, ...args);
    },
    info(message, ...args) {
      emit('info', message, ...args);
    },
    warn(message, ...args) {
      emit('warn', message, ...args);
    },
    success(message, ...args) {
      emit('success', message, ...args);
    },
    error(message, ...args) {
      emit('error', message, ...args);
    },
  };
}

const consola = wrapLogger();

function createLogger(options = {}) {
  const tag = options.tag || null;
  return tag ? consola.withTag(tag) : consola;
}

function makeTaskApi(logger, title) {
  let lastOutput = null;
  let skipped = false;

  return {
    logger,
    get skipped() {
      return skipped;
    },
    set output(value) {
      if (value == null) return;
      const next = String(value);
      if (!next || next === lastOutput) return;
      lastOutput = next;
      logger.info(`${title}: ${next}`);
    },
    get output() {
      return lastOutput;
    },
    skip(reason = 'Skipped') {
      skipped = true;
      logger.warn(`${title}: ${reason}`);
    },
  };
}

async function runTaskList(tasks, options = {}) {
  const logger = createLogger(options);
  const ctx = options.ctx || {};

  for (const taskDef of tasks) {
    logger.start(taskDef.title);
    const task = makeTaskApi(logger, taskDef.title);
    try {
      await taskDef.task(ctx, task);
      if (!task.skipped) logger.success(taskDef.title);
    } catch (err) {
      logger.error(`${taskDef.title}: ${err?.message || String(err)}`);
      throw err;
    }
  }

  return ctx;
}

function formatCount(current, total, noun, { failed = 0 } = {}) {
  const parts = [`${current}/${total} ${noun}`];
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(', ');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

module.exports = {
  consola,
  createLogger,
  runTaskList,
  formatCount,
  formatBytes,
};

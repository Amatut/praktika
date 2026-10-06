// Окружение запуска в уроке: учебные файлы и базы данных задания или шага (только чтение),
// честная пометка об учебной симуляции сети и «Файлы после запуска» в результатах.

import { Database, FileText, Files, Globe } from 'lucide-react';
import { Fragment } from 'react';
import { CodeBlock } from '../../components/CodeBlock.tsx';
import { Disclosure, Notice, Tag } from '../../components/ui.tsx';
import type { HttpMock } from '../../content/schema.ts';
import { formatBytes } from '../../pwa/offline.ts';
import type { RunFile } from '../../runner/types.ts';

/** Поля окружения у задания, теста, примера или прогноза. null у теста — «этого файла здесь нет». */
export interface EnvironmentSource {
  files?: Record<string, string | null>;
  databases?: Record<string, string | null>;
  http?: HttpMock[];
}

export function hasEnvironment(source: EnvironmentSource): boolean {
  return (
    Object.keys(source.files ?? {}).length > 0 ||
    Object.keys(source.databases ?? {}).length > 0 ||
    (source.http ?? []).length > 0
  );
}

function languageOf(path: string): string {
  return /\.py$/i.test(path) ? 'python' : 'text';
}

/** Чем ответит учебный сервер: «200», «404», «нет ответа вовремя». */
export function describeHttpMock(mock: HttpMock): string {
  if (mock.error === 'timeout') return 'сервер не отвечает вовремя';
  if (mock.error === 'connection') return 'нет соединения';
  return String(mock.status ?? 200);
}

/**
 * Длинный адрес в узкой колонке переносится по частям: после «https://» (имя сервера не рвётся посередине),
 * после «/» пути и перед «?» и «&». Текст элемента не меняется — <wbr> только разрешает перенос.
 */
function BreakableUrl({ text }: { text: string }) {
  const parts = text.split(/(?<=:\/\/)|(?<=[^:/]\/)|(?=[?&])/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Файлы, базы и сеть задания или шага. Файлы и SQL-скрипты свёрнуты: условие остаётся коротким,
 * а заглянуть в данные можно в любой момент. Пометка о сети видна всегда — ученик не должен думать,
 * что программа ходит в настоящий интернет.
 */
export function EnvironmentInfo({ source }: { source: EnvironmentSource }) {
  const files = Object.entries(source.files ?? {});
  const databases = Object.entries(source.databases ?? {});
  const http = source.http ?? [];
  if (files.length === 0 && databases.length === 0 && http.length === 0) return null;
  return (
    <div className="env-info">
      {http.length > 0 && (
        <Notice tone="warn" title="Сеть — учебная симуляция">
          <p>Ответы заранее записаны, настоящих запросов нет.</p>
          <ul className="env-http" aria-label="Адреса учебной симуляции сети">
            {http.map((mock, index) => (
              <li key={`${mock.method ?? 'GET'} ${mock.url} ${index}`}>
                <Globe aria-hidden="true" />
                {/* «GET» не отрывается от адреса, «→ 200» — от ответа; перенос — только внутри пути. */}
                <span>
                  <span className="mono">
                    {mock.method ?? 'GET'}
                    {'\u00a0'}
                    <BreakableUrl text={mock.url} />
                  </span>{' '}
                  <span className="env-http-status">→{'\u00a0'}{describeHttpMock(mock)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {files.length > 0 && (
        <Disclosure
          className="env-block"
          summary={
            <span className="env-summary">
              <Files aria-hidden="true" />
              Файлы задания · {files.length}
            </span>
          }
        >
          <div className="env-body">
            <Tag>только чтение</Tag>
            {files.map(([path, text]) =>
              text === null || text === '' ? (
                <p key={path} className="env-missing">
                  <FileText aria-hidden="true" />
                  <span className="mono">{path}</span>
                  <span>{text === null ? 'В этом случае файла нет.' : 'Пустой файл.'}</span>
                </p>
              ) : (
                <CodeBlock key={path} code={text} language={languageOf(path)} file={path} label={`Файл ${path}`} wrap />
              ),
            )}
          </div>
        </Disclosure>
      )}
      {databases.length > 0 && (
        <Disclosure
          className="env-block"
          summary={
            <span className="env-summary">
              <Database aria-hidden="true" />
              {databases.length === 1 ? `База данных: ${databases[0][0]}` : `Базы данных · ${databases.length}`}
            </span>
          }
        >
          <div className="env-body">
            <Tag>создаётся заново при каждом запуске</Tag>
            {databases.map(([path, script]) =>
              script === null ? (
                <p key={path} className="env-missing">
                  <Database aria-hidden="true" />
                  <span className="mono">{path}</span>
                  <span>В этом случае базы нет.</span>
                </p>
              ) : (
                <CodeBlock key={path} code={script} language="sql" file={path} label={`SQL-скрипт базы ${path}`} wrap />
              ),
            )}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/** «Файлы после запуска»: что программа создала или изменила в рабочей папке. */
export function ChangedFiles({ files }: { files: RunFile[] | undefined }) {
  if (!files || files.length === 0) return null;
  return (
    <div className="run-files">
      <h4 className="run-files-title">Файлы после запуска</h4>
      <ul className="run-files-list" aria-label="Файлы после запуска">
        {files.map((file) => (
          <li key={file.path}>
            <Disclosure
              open={files.length === 1}
              summary={
                <span className="run-file">
                  <FileText aria-hidden="true" />
                  <span className="mono run-file-name">{file.path}</span>
                  <span className="run-file-meta">
                    {file.status === 'created' ? 'новый' : 'изменён'} · {formatBytes(file.size)}
                  </span>
                </span>
              }
            >
              {file.text === null ? (
                <p className="run-file-note">Двоичный файл</p>
              ) : file.text === '' ? (
                <p className="run-file-note">Пустой файл.</p>
              ) : (
                <pre className="io-block">{file.text}</pre>
              )}
              {file.truncated && <p className="run-file-note">Показано начало файла.</p>}
            </Disclosure>
          </li>
        ))}
      </ul>
    </div>
  );
}

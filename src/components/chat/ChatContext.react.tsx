/** @jsxImportSource react */
import { useRef, useState } from 'react';
import { validateChatImages, type ChatImage } from '../../../electron/shared/agent-chat-types';

export async function readChatImages(files: File[]): Promise<ChatImage[]> {
  if (files.length > 4 || files.reduce((size, file) => size + file.size, 0) > 6 * 1024 * 1024)
    throw new Error('Attach up to four images, totaling less than 6 MB.');
  return validateChatImages(
    await Promise.all(
      files.map(async (file) => {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        return {
          name: file.name,
          mediaType: file.type,
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        };
      }),
    ),
  );
}

export function ChatContext(props: {
  files: string[];
  images: ChatImage[];
  disabled: boolean;
  onFiles: (files: string[]) => void;
  onImages: (files: File[]) => void;
  onRemoveImage: (index: number) => void;
  onListFiles?: () => Promise<string[]>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [all, setAll] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function showFiles() {
    setOpen(true);
    setLoading(true);
    setError('');
    try {
      setAll((await props.onListFiles?.()) ?? []);
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  }
  const matches = all.filter((file) =>
    file.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="chat-context">
      <div className="chat-context-actions">
        {props.onListFiles && (
          <button
            disabled={props.disabled}
            aria-expanded={open}
            onClick={() => (open ? setOpen(false) : void showFiles())}
          >
            ＋ Files
          </button>
        )}
        <button disabled={props.disabled} onClick={() => picker.current?.click()}>
          ＋ Images
        </button>
        <input
          hidden
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(event) => {
            props.onImages(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>
      {open && (
        <div className="chat-file-picker">
          <input
            autoFocus
            aria-label="Find a file to attach"
            placeholder="Search worktree files…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          {loading ? (
            <p>Loading files…</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : (
            <>
              <div>
                {matches.slice(0, 100).map((file) => (
                  <button
                    key={file}
                    disabled={props.disabled}
                    aria-pressed={props.files.includes(file)}
                    onClick={() =>
                      props.onFiles(
                        props.files.includes(file)
                          ? props.files.filter((entry) => entry !== file)
                          : [...props.files, file],
                      )
                    }
                  >
                    {props.files.includes(file) ? '✓ ' : ''}
                    {file}
                  </button>
                ))}
              </div>
              <small>
                {matches.length > 100
                  ? 'Showing the first 100 matches. Refine your search.'
                  : `${matches.length} files`}
              </small>
            </>
          )}
          <button onClick={() => setOpen(false)}>Done</button>
        </div>
      )}
      <div className="chat-context-chips">
        {props.files.map((file) => (
          <button
            key={file}
            disabled={props.disabled}
            title={`Remove ${file}`}
            onClick={() => props.onFiles(props.files.filter((entry) => entry !== file))}
          >
            {file} ×
          </button>
        ))}
        {props.images.map((image, index) => (
          <button
            key={index}
            disabled={props.disabled}
            title={`Remove ${image.name}`}
            onClick={() => props.onRemoveImage(index)}
          >
            <img src={`data:${image.mediaType};base64,${image.data}`} alt="" />
            {image.name} ×
          </button>
        ))}
      </div>
    </div>
  );
}

const LIFF_ID = process.env.LIFF_ID || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

export function buildPollFlex({ pollId, title, options }) {
  const altText = `日程投票: ${title}`;
  // Simpler path: if PUBLIC_BASE_URL is set, link directly to the endpoint to avoid LIFF two-step redirect complexity.
  const directUrl = PUBLIC_BASE_URL
    ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/liff/index.html?pollId=${encodeURIComponent(pollId)}`
    : null;
  const liffUrl = LIFF_ID ? `https://liff.line.me/${LIFF_ID}?pollId=${encodeURIComponent(pollId)}` : null;
  const formUrl = directUrl || liffUrl;
  const contents = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '日程投票', weight: 'bold', size: 'sm', color: '#aaaaaa' },
        { type: 'text', text: title, weight: 'bold', size: 'md', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '候補（日程）', weight: 'bold', size: 'sm', color: '#888888' },
        ...options.slice(0, 10).map((opt) => ({
          type: 'box',
          layout: 'baseline',
          contents: [
            { type: 'text', text: '・', size: 'sm', color: '#666666', flex: 0 },
            { type: 'text', text: opt.label, size: 'sm', wrap: true, flex: 1 },
          ],
        })),
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '投票は「フォームで回答」から行ってください。', size: 'xs', color: '#888888', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      contents: (
        formUrl
          ? [
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                color: '#1E90FF',
                action: {
                  type: 'uri',
                  label: 'フォームで回答',
                  uri: formUrl,
                },
              },
            ]
          : [
              {
                type: 'text',
                text: 'フォームURL未設定（LIFF_ID または PUBLIC_BASE_URL を設定）',
                size: 'xs',
                color: '#888888',
              },
            ]
      ),
    },
  };

  return {
    type: 'flex',
    altText,
    contents,
  };
}

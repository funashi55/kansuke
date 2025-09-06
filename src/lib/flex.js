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
                color: '#00c300',
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

export function buildShopCarousel(recommendations, { altText = 'お店の候補' } = {}) {
  if (!recommendations || !recommendations.length) {
    return { type: 'text', text: 'すみません、条件に合うお店が見つかりませんでした。' };
  }

  const bubbles = recommendations.slice(0, 5).map(shop => {
    const genres = Array.isArray(shop.genres) ? shop.genres.join(' / ') : 'ジャンル情報なし';
    const imageUrl = shop.image_url || 'https://scdn.line-apps.com/n/channel_devcenter/img/fx/01_1_cafe.png';

    return {
      type: 'bubble',
      hero: {
        type: 'image',
        url: imageUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
        action: { type: 'uri', uri: shop.google_maps_url || 'http://line.me/' },
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: shop.name, weight: 'bold', size: 'xl', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'sm',
            contents: [
              { 
                type: 'box', 
                layout: 'baseline', 
                spacing: 'sm', 
                contents: [
                  { type: 'text', text: 'エリア', color: '#aaaaaa', size: 'sm', flex: 2 },
                  { type: 'text', text: shop.area || '-', wrap: true, color: '#666666', size: 'sm', flex: 5 }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  { type: 'text', text: 'ジャンル', color: '#aaaaaa', size: 'sm', flex: 2 },
                  { type: 'text', text: genres, wrap: true, color: '#666666', size: 'sm', flex: 5 }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                margin: 'md',
                contents: [
                  { type: 'text', text: 'おすすめ理由', size: 'sm', color: '#aaaaaa' },
                  { type: 'text', text: shop.reason || '-', wrap: true, size: 'sm', color: '#666666' }
                ]
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: { type: 'uri', label: 'Googleマップで見る', uri: shop.google_maps_url || 'http://line.me/' }
          }
        ],
        flex: 0
      }
    };
  });

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}
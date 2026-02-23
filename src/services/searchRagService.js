/**
 * RAG 검색 서비스
 * lod-rag-server /search 호출 → wikibot 표준 형식 변환
 */

const axios = require('axios');

const RAG_SERVER_URL = process.env.RAG_SERVER_URL || 'http://localhost:8100';

class SearchRagService {
  constructor() {
    this.ragServerUrl = RAG_SERVER_URL;
  }

  async search(query, sourceFilter = null) {
    try {
      const response = await axios.post(`${this.ragServerUrl}/search`, {
        query,
        source_filter: sourceFilter
      }, { timeout: 30000 });

      const { answer, sources, confidence } = response.data;

      return {
        success: true,
        data: {
          title: sources[0]?.title || '',
          date: sources[0]?.date || '',
          content: answer,
          link: sources[0]?.url || '',
          board_name: sources[0]?.board_name || '',
          confidence: confidence,
          otherResults: sources.slice(1).map(s => ({
            title: s.title,
            link: s.url,
            date: s.date,
            board: s.board_name
          }))
        }
      };
    } catch (error) {
      console.error('RAG search error:', error.message);
      return {
        success: false,
        data: {
          content: 'RAG 검색 서버에 연결할 수 없습니다.',
          confidence: 'not_found'
        }
      };
    }
  }
}

module.exports = { SearchRagService };

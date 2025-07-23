const axios = require('axios');

class WikiService {
  constructor() {
    this.baseUrl = process.env.WIKI_API_BASE_URL || 'http://192.168.0.3:8000';
    this.timeout = parseInt(process.env.WIKI_API_TIMEOUT) || 30000;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  async search(query, userId, roomId, limit = 10) {
    try {
      const response = await this.client.get('/api/messenger/search', {
        params: {
          q: query,
          user_id: userId,
          room_id: roomId,
          limit: limit,
          type: 'search'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Wiki search error:', error.message);
      throw new Error('검색 중 오류가 발생했습니다.');
    }
  }

  async question(query, userId, roomId) {
    try {
      const response = await this.client.get('/api/messenger/search', {
        params: {
          q: query,
          user_id: userId,
          room_id: roomId,
          limit: 10,
          type: 'question'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Wiki question error:', error.message);
      throw new Error('질문 처리 중 오류가 발생했습니다.');
    }
  }

  async getProbability(query, userId, roomId) {
    try {
      const response = await this.client.get('/api/messenger/search', {
        params: {
          q: query,
          user_id: userId,
          room_id: roomId,
          limit: 10,
          type: 'probability'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Wiki probability error:', error.message);
      throw new Error('확률 정보 조회 중 오류가 발생했습니다.');
    }
  }

  async getStats() {
    try {
      const response = await this.client.get('/api/messenger/stats');
      return response.data;
    } catch (error) {
      console.error('Wiki stats error:', error.message);
      throw new Error('통계 정보 조회 중 오류가 발생했습니다.');
    }
  }

  async healthCheck() {
    try {
      const response = await this.client.get('/api/messenger/health');
      return {
        success: true,
        message: '✅ 서버 연결이 정상입니다.',
        data: response.data
      };
    } catch (error) {
      console.error('Wiki health check error:', error.message);
      return {
        success: false,
        message: '❌ 서버 연결에 문제가 있습니다.'
      };
    }
  }

  async clearCache() {
    try {
      const response = await this.client.post('/api/messenger/clear-cache');
      return response.data;
    } catch (error) {
      console.error('Wiki cache clear error:', error.message);
      throw new Error('캐시 초기화 중 오류가 발생했습니다.');
    }
  }
}

module.exports = { WikiService };
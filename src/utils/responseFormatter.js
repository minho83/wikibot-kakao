class ResponseFormatter {
  constructor() {
    this.maxMessageLength = 2000;
  }

  format(result) {
    if (!result) {
      return {
        message: '결과를 처리할 수 없습니다.',
        type: 'text'
      };
    }

    if (result.success === false) {
      return {
        message: result.message || '오류가 발생했습니다.',
        type: 'text'
      };
    }

    if (typeof result.message === 'string') {
      return {
        message: this.truncateMessage(result.message),
        type: 'text'
      };
    }

    if (result.data) {
      return this.formatDataResponse(result);
    }

    return {
      message: '응답을 처리할 수 없습니다.',
      type: 'text'
    };
  }

  formatDataResponse(result) {
    try {
      if (result.data.results && Array.isArray(result.data.results)) {
        return this.formatSearchResults(result);
      }
      
      if (result.data.stats) {
        return this.formatStatsResponse(result.data.stats);
      }

      return {
        message: result.message || JSON.stringify(result.data, null, 2),
        type: 'text'
      };
    } catch (error) {
      console.error('Response formatting error:', error);
      return {
        message: result.message || '응답 형식화 중 오류가 발생했습니다.',
        type: 'text'
      };
    }
  }

  formatSearchResults(result) {
    const { data } = result;
    let message = `🔍 검색결과 (${data.total_results}건)\\n`;
    message += `⏱️ 처리시간: ${data.processing_time}초\\n\\n`;
    
    if (data.results && data.results.length > 0) {
      data.results.forEach((item, index) => {
        message += `${index + 1}. ${item.title || item.content?.substring(0, 50) || 'No title'}\\n`;
        if (item.score) {
          message += `   유사도: ${(item.score * 100).toFixed(1)}%\\n`;
        }
        message += '\\n';
      });
    } else {
      message += '검색 결과가 없습니다.';
    }

    return {
      message: this.truncateMessage(message),
      type: 'text'
    };
  }

  formatStatsResponse(stats) {
    let message = '📊 데이터베이스 통계\\n\\n';
    
    Object.entries(stats).forEach(([key, value]) => {
      message += `${key}: ${value}\\n`;
    });

    return {
      message: this.truncateMessage(message),
      type: 'text'
    };
  }

  getHelpMessage() {
    const helpText = `🤖 어둠의전설 위키봇 도움말

📌 사용 가능한 명령어:
• !검색 [검색어] - 하이브리드 검색 실행
• !질문 [질문내용] - AI 기반 질의응답  
• !확률 [뽑기명] - 넥슨나우 확률 정보
• !통계 - 데이터베이스 통계 확인
• !연결테스트 - 서버 연결 상태 확인
• !캐시클리어 - AI 답변 캐시 초기화
• !도움말 - 이 도움말 표시

⚡ 주의사항:
- 명령어 사용 후 5초 쿨다운이 있습니다
- 한 번에 하나의 명령어만 처리됩니다

💡 예시:
!검색 퀘스트
!질문 레벨업 방법이 뭐야?`;

    return {
      success: true,
      message: helpText
    };
  }

  truncateMessage(message) {
    if (message.length <= this.maxMessageLength) {
      return message;
    }
    
    return message.substring(0, this.maxMessageLength - 50) + '\\n\\n... (메시지가 너무 길어 일부가 생략되었습니다)';
  }
}

module.exports = { ResponseFormatter };
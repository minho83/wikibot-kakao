class ResponseFormatter {
  constructor() {
    this.maxMessageLength = 2000;
  }

  format(result) {
    if (!result) {
      return { message: '결과를 처리할 수 없습니다.', type: 'text' };
    }

    if (result.success === false) {
      return { message: result.message || '오류가 발생했습니다.', type: 'text' };
    }

    if (typeof result.message === 'string') {
      return { message: this.truncateMessage(result.message), type: 'text' };
    }

    return { message: '응답을 처리할 수 없습니다.', type: 'text' };
  }

  getHelpMessage() {
    const helpText = `🤖 어둠의전설 검색봇

📌 사용 가능한 명령어:
• !검색 [검색어] - AI 게임정보 검색
• !현자 [검색어] - 게시판 검색
• !공지 - 최신 점검/공지사항
• !공지 [날짜] - 특정 날짜 공지 검색
• !업데이트 - 최신 업데이트 내역
• !업데이트 [날짜] - 특정 날짜 업데이트 검색
• !파티 - 파티 빈자리 현황 (웹)
• !도움말 - 이 도움말 표시

💡 검색 예시:
!검색 활쏘는자 2차직업
!현자 발록
!공지 2/5`;

    return { success: true, message: helpText };
  }

  truncateMessage(message) {
    if (message.length <= this.maxMessageLength) {
      return message;
    }
    return message.substring(0, this.maxMessageLength - 50) + '\n\n... (결과가 더 있습니다)';
  }
}

module.exports = { ResponseFormatter };

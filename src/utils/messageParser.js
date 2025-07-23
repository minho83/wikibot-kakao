class MessageParser {
  constructor() {
    this.supportedCommands = [
      '!검색', '!질문', '!확률', '!도움말', 
      '!통계', '!연결테스트', '!캐시클리어'
    ];
  }

  parse(message) {
    if (!message || typeof message !== 'string') {
      return {
        isCommand: false,
        command: null,
        query: null,
        originalMessage: message
      };
    }

    const trimmedMessage = message.trim();
    
    if (!trimmedMessage.startsWith('!')) {
      return {
        isCommand: false,
        command: null,
        query: trimmedMessage,
        originalMessage: message
      };
    }

    const parts = trimmedMessage.split(' ');
    const command = parts[0];
    const query = parts.slice(1).join(' ').trim();

    return {
      isCommand: this.supportedCommands.includes(command),
      command: command,
      query: query || null,
      originalMessage: message,
      isValidCommand: this.supportedCommands.includes(command)
    };
  }

  validateCommand(command) {
    return this.supportedCommands.includes(command);
  }

  getCommands() {
    return [...this.supportedCommands];
  }
}

module.exports = { MessageParser };
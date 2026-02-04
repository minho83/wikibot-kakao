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

    if (result.results && Array.isArray(result.results)) {
      return this.formatSearchResults(result);
    }

    if (result.stats) {
      return this.formatStatsResponse(result.stats);
    }

    if (typeof result.message === 'string') {
      return { message: this.truncateMessage(result.message), type: 'text' };
    }

    return { message: '응답을 처리할 수 없습니다.', type: 'text' };
  }

  formatSearchResults(result) {
    if (result.results.length === 0) {
      return { message: result.message, type: 'text' };
    }

    let message = `🔍 "${result.query}" 검색 결과 (${result.count}건)\n\n`;

    result.results.forEach((item, index) => {
      message += this.formatItem(item);
      if (index < result.results.length - 1) {
        message += '\n';
      }
    });

    return { message: this.truncateMessage(message), type: 'text' };
  }

  formatItem(item) {
    switch (item.category) {
      case 'item':
        return this.formatGameItem(item);
      case 'skill':
        return this.formatSkill(item);
      case 'spell':
        return this.formatSpell(item);
      default:
        return `${item.name}\n`;
    }
  }

  formatGameItem(item) {
    const icon = this.getItemIcon(item.categoryName);
    let lines = [`${icon} [${item.categoryName}] ${item.name}`];

    // 직업, 레벨, 성별 (의상/모자만)
    let infoLine = [];
    if (item.job && item.job !== '공통') infoLine.push(`직업: ${item.job}`);
    if (item.level && item.level !== '0') infoLine.push(`Lv.${item.level}`);
    if (['방어구'].includes(item.categoryName) && item.gender) {
      infoLine.push(item.gender);
    }
    if (infoLine.length > 0) lines.push(`├ ${infoLine.join(' | ')}`);

    // 무기: 데미지
    if (item.categoryName === '무기') {
      if (item.smallDamage || item.largeDamage) {
        const small = this.formatDamage(item.smallDamage);
        const large = this.formatDamage(item.largeDamage);
        if (small || large) {
          lines.push(`├ 데미지: ${small || '-'} (소형) / ${large || '-'} (대형)`);
        }
      }
      // 명중/데미지 보정
      let roleInfo = [];
      if (item.hitRole && item.hitRole !== '0') roleInfo.push(`명중+${item.hitRole}`);
      if (item.damRole && item.damRole !== '0') roleInfo.push(`데미지+${item.damRole}`);
      if (roleInfo.length > 0) lines.push(`├ ${roleInfo.join(' / ')}`);
    }

    // 방어구/방패: AC, 마방
    if (['방어구', '방패'].includes(item.categoryName)) {
      let defLine = [];
      if (item.ac && item.ac !== '0') defLine.push(`AC: ${item.ac}`);
      if (item.magicDefense && item.magicDefense !== '0') defLine.push(`마방: ${item.magicDefense}`);
      if (defLine.length > 0) lines.push(`├ ${defLine.join(' | ')}`);
    }

    // HP/MP
    let hpMp = [];
    if (item.hp && item.hp !== '0') hpMp.push(`HP${this.formatStat(item.hp)}`);
    if (item.mp && item.mp !== '0') hpMp.push(`MP${this.formatStat(item.mp)}`);
    if (hpMp.length > 0) lines.push(`├ ${hpMp.join(' / ')}`);

    // 스탯
    const stats = this.formatStats(item);
    if (stats) lines.push(`├ ${stats}`);

    // 설명
    if (item.description && item.description.trim()) {
      lines.push(`└ ${item.description}`);
    } else {
      // 마지막 줄 수정
      if (lines.length > 1) {
        lines[lines.length - 1] = lines[lines.length - 1].replace('├', '└');
      }
    }

    return lines.join('\n') + '\n';
  }

  formatSkill(item) {
    let lines = [`⚔️ [기술] ${item.displayName || item.name}`];

    // 설명
    if (item.description && item.description.trim()) {
      lines.push(`├ ${item.description}`);
    }

    // 습득 조건
    const requirements = this.formatRequirements(item);
    if (requirements.length > 0) {
      requirements.forEach((req, idx) => {
        const prefix = idx === requirements.length - 1 ? '└' : '├';
        lines.push(`${prefix} ${req}`);
      });
    } else if (lines.length > 1) {
      lines[lines.length - 1] = lines[lines.length - 1].replace('├', '└');
    }

    return lines.join('\n') + '\n';
  }

  formatSpell(item) {
    let lines = [`✨ [마법] ${item.displayName || item.name}`];

    // MP 소모
    if (item.costMana && item.costMana !== '0') {
      lines.push(`├ MP 소모: ${Number(item.costMana).toLocaleString()}`);
    }

    // 설명
    if (item.description && item.description.trim()) {
      lines.push(`├ ${item.description}`);
    }

    // 습득 조건
    const requirements = this.formatRequirements(item);
    if (requirements.length > 0) {
      requirements.forEach((req, idx) => {
        const prefix = idx === requirements.length - 1 ? '└' : '├';
        lines.push(`${prefix} ${req}`);
      });
    } else if (lines.length > 1) {
      lines[lines.length - 1] = lines[lines.length - 1].replace('├', '└');
    }

    return lines.join('\n') + '\n';
  }

  formatRequirements(item) {
    let reqs = [];

    // 레벨, 골드
    let levelGold = [];
    if (item.needLevel && item.needLevel !== '0' && item.needLevel !== '1') {
      levelGold.push(`습득 레벨: ${item.needLevel}`);
    }
    if (item.needGold && item.needGold !== '0') {
      levelGold.push(`골드: ${Number(item.needGold).toLocaleString()}`);
    }
    if (levelGold.length > 0) reqs.push(levelGold.join(' | '));

    // 필요 스탯
    const needStats = this.formatNeedStats(item);
    if (needStats) reqs.push(`필요 스탯: ${needStats}`);

    // 필요 아이템
    if (item.needItem && item.needItem.trim()) {
      const items = this.parseNeedItem(item.needItem);
      if (items) reqs.push(`필요 아이템: ${items}`);
    }

    return reqs;
  }

  formatDamage(damage) {
    if (!damage || damage === '') return null;
    // "335m365" -> "335~365"
    return damage.replace('m', '~');
  }

  formatStat(value) {
    const num = parseInt(value);
    if (num > 0) return `+${num}`;
    return `${num}`;
  }

  formatStats(item) {
    const stats = [];
    if (item.str && item.str !== '0') stats.push(`STR${this.formatStat(item.str)}`);
    if (item.dex && item.dex !== '0') stats.push(`DEX${this.formatStat(item.dex)}`);
    if (item.int && item.int !== '0') stats.push(`INT${this.formatStat(item.int)}`);
    if (item.wis && item.wis !== '0') stats.push(`WIS${this.formatStat(item.wis)}`);
    if (item.con && item.con !== '0') stats.push(`CON${this.formatStat(item.con)}`);
    return stats.length > 0 ? stats.join(' ') : null;
  }

  formatNeedStats(item) {
    const stats = [];
    if (item.needStr && item.needStr !== '0') stats.push(`STR ${item.needStr}`);
    if (item.needDex && item.needDex !== '0') stats.push(`DEX ${item.needDex}`);
    if (item.needInt && item.needInt !== '0') stats.push(`INT ${item.needInt}`);
    if (item.needWis && item.needWis !== '0') stats.push(`WIS ${item.needWis}`);
    if (item.needCon && item.needCon !== '0') stats.push(`CON ${item.needCon}`);
    return stats.length > 0 ? stats.join(' / ') : null;
  }

  parseNeedItem(needItem) {
    // "금속괴, 2, 나겔링별스톤, 3" -> "금속괴 2개, 나겔링별스톤 3개"
    const parts = needItem.split(',').map(s => s.trim());
    const items = [];
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i] && parts[i + 1]) {
        items.push(`${parts[i]} ${parts[i + 1]}개`);
      }
    }
    return items.length > 0 ? items.join(', ') : null;
  }

  getItemIcon(categoryName) {
    const icons = {
      '무기': '🗡️',
      '방어구': '🛡️',
      '방패': '🛡️',
      '악세서리': '📿',
      '상자': '📦',
      '소비': '🧪',
      '기타': '📄'
    };
    return icons[categoryName] || '📄';
  }

  formatStatsResponse(stats) {
    let message = '📊 데이터베이스 통계\n\n';
    Object.entries(stats).forEach(([key, value]) => {
      message += `• ${key}: ${value.toLocaleString()}개\n`;
    });
    return { message: this.truncateMessage(message), type: 'text' };
  }

  getHelpMessage() {
    const helpText = `🤖 어둠의전설 DB 검색봇

📌 사용 가능한 명령어:
• !검색 [검색어] - 아이템/기술/마법 검색
• !공지 - 최신 점검/공지사항
• !업데이트 - 최신 업데이트 내역
• !통계 - 데이터베이스 통계
• !도움말 - 이 도움말 표시

💡 검색 예시:
!검색 메테오
!검색 프람베르그
!검색 ㅋㄹㅅ (초성 검색)

⚡ 오타가 있어도 유사한 결과를 찾아줍니다!`;

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

const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

class CommunityService {
    constructor() {
        this.baseUrl = 'https://lod.nexon.com';
        this.searchPath = '/Community/game';
    }

    async search(keyword) {
        try {
            const url = `${this.baseUrl}${this.searchPath}`;
            // SearchBoard=1: Game Board, Category2=1: Seo Server (Default), SearchType=0: Title, SearchKeyword: Keyword
            const params = {
                SearchBoard: 1,
                Category2: 1,
                SearchType: 0,
                SearchKeyword: keyword
            };

            const response = await axios.get(url, {
                params,
                responseType: 'arraybuffer', // Important for decoding if needed, though most modern sites are UTF-8
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });

            const html = response.data; // axios auto-decodes utf-8 usually, but let's be safe if it's EUC-KR
            // Check content-type or just assume UTF-8 for now as seen in meta tag <meta content="text/html; charset=utf-8" http-equiv="Content-Type">
            const content = html.toString('utf-8');

            const $ = cheerio.load(content);
            const listItems = $('.community_s1 li');

            if (listItems.length === 0) {
                return [];
            }

            const results = [];
            listItems.each((index, element) => {
                if (index >= 3) return false; // Limit to 3 results

                const titleElement = $(element).find('.tit');
                const linkElement = $(element).find('a');
                const timeElement = $(element).find('.time');

                // Remove .s_ts span (highlighted text) to get clean title if needed, 
                // but .text() usually gets all text. 
                // However, the structure is <span class="tit"><span class='s_ts'>KEYWORD</span> rest of title</span>
                const title = titleElement.text().trim();
                const link = linkElement.attr('href');
                const date = timeElement.text().trim();

                if (title && link) {
                    results.push({
                        title,
                        link, // Relative path
                        date
                    });
                }
            });

            return results;

        } catch (error) {
            console.error('Error during search:', error);
            throw new Error('게시판 검색 중 오류가 발생했습니다.');
        }
    }

    async getPostDetail(link) {
        try {
            const url = `${this.baseUrl}${link}`;
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });

            const content = response.data.toString('utf-8');
            const $ = cheerio.load(content);

            // Main content selector based on inspection: .board_text
            const boardText = $('.board_text');

            // Remove scripts and styles if any inside
            boardText.find('script').remove();
            boardText.find('style').remove();

            // Get text, replace <br> with newlines
            boardText.find('br').replaceWith('\n');
            boardText.find('p').each((i, el) => {
                $(el).append('\n');
            });

            let text = boardText.text().trim();

            // 구분선 정리 (----, ====, ~~~~ 등 3개 이상 반복되는 기호)
            text = text.replace(/[-=~_]{3,}/g, '---');
            // 연속 공백/빈줄 정리
            text = text.replace(/\n\s*\n/g, '\n').trim();

            return text;

        } catch (error) {
            console.error('Error getting post detail:', error);
            throw new Error('게시글 내용을 가져오는 중 오류가 발생했습니다.');
        }
    }

    async searchAndParse(keyword) {
        try {
            const searchResults = await this.search(keyword);

            if (searchResults.length === 0) {
                return {
                    success: false,
                    message: `'${keyword}'에 대한 검색 결과가 없습니다.`
                };
            }

            // Get detail of the first result
            const firstResult = searchResults[0];
            const detailContent = await this.getPostDetail(firstResult.link);

            // Limit content length for chat
            const maxLength = 500;
            const displayContent = detailContent.length > maxLength
                ? detailContent.substring(0, maxLength) + '...\n(내용이 너무 길어 생략되었습니다)'
                : detailContent;

            return {
                success: true,
                data: {
                    title: firstResult.title,
                    date: firstResult.date,
                    content: displayContent,
                    link: `${this.baseUrl}${firstResult.link}`,
                    otherResults: searchResults.slice(1) // Return other results for "Did you mean?" or list
                }
            };

        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }
}

module.exports = { CommunityService };

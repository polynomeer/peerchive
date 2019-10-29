const axios = require('axios')
const cheerio = require('cheerio')

const getHtml = async (url) => {
  try {
    return await axios.get(url);
  } catch (error) {
    console.error(error);
  }
};

const getYU = async (req, res) => {
  getHtml("http://www.yu.ac.kr/_korean/main/index.php")
  .then(html => {
    let ulList = [];
    const $ = cheerio.load(html.data);

    const $bodyList = $("div.toggle-wrapper div#toggle_c ul.conbox").children("li");

    $bodyList.each(function(i, elem) {
       ulList[i] = {
         url: "http://www.yu.ac.kr" + $(this).find('a').attr('href'),
         title: $(this).find('a').text(),
       };
     });

    const list = ulList.filter(n => n.title);

    res.json({ list })
  })
}

module.exports = {
  getHtml,
  getYU
}

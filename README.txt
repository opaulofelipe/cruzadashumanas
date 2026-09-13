CRUZADAS DENSAS — INSTALAÇÃO

1. Coloque estes quatro arquivos na raiz do site:
   index.html
   style.css
   app.js
   generator-worker.js

2. Crie uma pasta chamada "dados" na raiz.

3. Dentro de /dados, coloque exatamente estes 8 arquivos:
   palavras-2.json
   palavras-3.json
   palavras-4.json
   palavras-5.json
   palavras-6.json
   palavras-7.json
   palavras-8-10.json
   palavras-11mais.json

4. Publique normalmente no GitHub Pages.

O jogo também tenta encontrar os JSONs na própria raiz caso você não use a pasta /dados.

COMO O GERADOR FUNCIONA
- Primeiro cria uma grade densa com simetria e poucos blocos pretos.
- A grade é dividida em espaços horizontais e verticais.
- Depois um solver de restrições preenche todos os espaços usando os 8 JSONs.
- A grade só é aceita com pelo menos 30 respostas.
- O alvo inicial é aproximadamente 44 ou mais respostas e no máximo 26% de casas pretas.
- Todas as casas brancas pertencem a palavras horizontais e verticais; não é o modelo antigo de "pendurar" palavras uma nas outras.

OBSERVAÇÃO
Nenhum gerador pode garantir matematicamente uma solução densa para qualquer banco arbitrário. Se uma combinação não puder ser preenchida, o jogo tenta outros templates durante até cerca de 14 segundos e, se necessário, pede uma nova tentativa.

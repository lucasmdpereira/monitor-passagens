# Monitor de passagens — scripts JSON

Fork enxuto de [ManoelDiniz/monitor-passagens](https://github.com/ManoelDiniz/monitor-passagens), focado em buscar passagens nacionais operadas por **GOL, LATAM e Azul** através de **Kiwi, MaxMilhas e Google Flights**. Os provedores consultam endpoints usados pelos sites; não precisam de navegador nem de chaves na configuração testada.

A entrada é um objeto JSON. Cada rota gera três buscas por provedor: ida e volta juntas, somente ida e somente volta. No Google, a busca de ida e volta usa uma consulta inicial e consultas adicionais para obter as voltas de cada ida selecionada. A saída preserva preços em centavos para o grupo inteiro, itinerários, condições conhecidas e erros por consulta.

## Executar

Requer Node.js 22.12 ou posterior.

```sh
npm ci --ignore-scripts
npm run --silent search -- examples/search.json > resultado.json
```

```json
{
  "origins": ["CNF", "GRU", "GIG"],
  "destinations": ["REC"],
  "departure_date": "2027-03-10",
  "return_date": "2027-03-17",
  "passengers": { "adults": 2 },
  "max_routes": 3
}
```

O comando também aceita JSON em stdin: `node --import tsx src/cli/search.ts -`. Após `npm run build`, use `node dist/cli/search.js arquivo.json`. A função `searchFlights(objeto)` é exportada por `dist/search.js`.

O stdout contém apenas um objeto JSON; use `npm run --silent` para suprimir o banner do npm. Código de saída 0: há ofertas utilizáveis, possivelmente parciais; 2: entrada inválida; 3: nenhuma oferta utilizável. Sempre examine `status` e os resultados de cada consulta.

## Padrões e buscas nacionais

- Passageiros: **2 adultos**. Pode passar um inteiro em `passengers` ou `{ "adults": 2 }`; crianças e bebês ainda não são suportados.
- Origens: **CNF, PLU, GIG, SDU, GRU, CGH e VCP**.
- Destinos omitidos: todos os aeroportos brasileiros do catálogo, priorizando os que registram serviço regular. Não é prova de existência de voo.
- Fontes: `kiwi`, `maxmilhas`, `google`; podem ser escolhidas em `providers`.
- `max_stops`: até 2 paradas por direção, padrão 2.
- `max_routes`: **1 rota por execução**, configurável de 1 a 100. `cursor`: 0 por padrão.

O limite mantém a busca ampla controlada. `coverage.total_routes` informa o tamanho do plano, e `coverage.next_cursor` permite continuar o próximo lote com a mesma entrada. Um lote não representa uma busca de todo o Brasil. O catálogo contém aeroportos sem voos comerciais; essas consultas podem retornar vazio.

Para inspecionar o plano sem acessar nenhum provedor:

```sh
npm run --silent plan -- examples/domestic-search.json
```

As consultas rodam sequencialmente. Cada requisição tem timeout incluindo o corpo da resposta; padrão 45 segundos (`PROVIDER_TIMEOUT_MS`, entre 1000 e 125000). O padrão é uma tentativa (`PROVIDER_RETRIES`, 1 ou 2). HTTP 403/429 encerra as demais consultas à fonte no lote quando o bloqueio alcança o resultado da fonte. Falhas por companhia na MaxMilhas ficam registradas como parciais.

## Como ler o resultado

- `routes[].queries[]`: fonte, tipo de busca, pedido enviado, status, ofertas e diagnósticos.
- `offers[].price.amount_minor`: total em centavos BRL para todos os adultos; nunca multiplicamos novamente esse valor.
- `offers[].itinerary`: segmentos de ida e volta, com validação de aeroportos, datas de partida e companhias. Conexões internacionais ou com troca de aeroporto são descartadas.
- `offers[].conditions`: cabine, bagagem conhecida, pagamento e informação de taxas. A MaxMilhas pode oferecer desconto exclusivo no **PIX**.
- `routes[].comparison`: menor total observado de ida e volta versus a soma dos menores trechos avulsos. A diferença é aritmética; **`conditions_comparable: false`** e **`exhaustive: false`** impedem tratá-la como equivalência de condições ou mínimo global.
- `booking_confirmed: false`: o preço é resultado de pesquisa, sem reserva ou compra. A disponibilidade pode mudar.

A Kiwi pode combinar companhias e bilhetes separados; proteção de conexão não foi validada. Tokens opacos de reserva não são exportados: o link da Kiwi fica nulo. A MaxMilhas mantém o link público com datas e quantidade de adultos. Seus horários conservam o formato recebido, mas o fuso é marcado como não confirmado: o site mostra horários locais mesmo quando o BFF adiciona `Z`.

O Google Flights completa a busca de ida e volta em duas etapas: lista as idas e consulta as voltas fixando todos os segmentos de cada ida. O preço da segunda etapa é o total do par para os adultos solicitados; não é somado ao preço preliminar. Apenas pares com volta válida entram na comparação.

A expansão é sequencial, prioriza os menores preços preliminares e consulta até **20 idas distintas** por rota. Idas não expandidas ou com falha conservam o preço preliminar, `itinerary.complete: false` e `comparison_eligible: false`, com o motivo registrado. Falhas de transporte, RPC ou estrutura interrompem a expansão para evitar repetir uma consulta defeituosa. HTTP 403/429 também interrompe as buscas restantes ao Google no lote.

O total Google corresponde à etapa de pesquisa do par escolhido. As opções finais de vendedores podem oferecer preços e condições diferentes; não consultamos todas essas opções nem validamos checkout. Erros internos de RPC são explícitos, mesmo com HTTP 200. Os links Google ficam nulos porque o link original não preservava os passageiros.

Os endpoints internos podem mudar sem aviso. Falha ou resposta incompatível nunca deve ser interpretada como tarifa zero ou ausência comprovada de voos.

## Verificação

```sh
npm test
npm run typecheck
npm run build
```

Os testes usam respostas reduzidas e saneadas, além de cenários de erro. As consultas reais são separadas dos testes automatizados. Veja [a validação inicial de 24/11/2026](docs/validation/2026-11-24.md) e [a correção do RT Google](docs/validation/2026-11-24-google-rt.md).

Não há painel, banco, notificações, execução agendada ou integração n8n nesta versão. A saída JSON é o ponto de integração futuro. O trabalho anterior em `flight-deals-agent` permanece independente.

Autoria, procedência e situação da licença: [UPSTREAM.md](docs/UPSTREAM.md).

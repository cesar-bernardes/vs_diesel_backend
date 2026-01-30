require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken'); // Biblioteca para gerar tokens

// Importa o middleware de segurança
const authMiddleware = require('./middleware/auth'); 
const { requireCargo, denyCargo } = require('./middleware/authorize');

const app = express();
app.use(express.json());
app.use(cors());

// Conexão com o Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==================================================================
// 🔓 ÁREA PÚBLICA - ROTAS QUE NÃO PRECISAM DE SENHA
// ==================================================================

// 1. Rota de Teste (Health Check)
app.get('/', (req, res) => {
    res.json({ status: 'Online', message: 'Sistema VR Diesel Seguro 🔒' });
});

// 2. Rota de LOGIN (Gera o Token)
app.post('/api/login', async (req, res) => {
    const { nome, senha } = req.body;

    // Busca o usuário no banco
    const { data: user, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('nome', nome)
        .eq('senha', senha)
        .single();

    if (error || !user) {
        return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    // Inclui o CARGO no token e na resposta
    const token = jwt.sign(
        { id: user.id, nome: user.nome, cargo: user.cargo }, 
        process.env.SUPABASE_KEY, 
        { expiresIn: '8h' }
    );

    res.json({ 
        token, 
        user: { id: user.id, nome: user.nome, cargo: user.cargo } 
    });
});


// ==================================================================
// 👮‍♂️ BARREIRA DE SEGURANÇA (MIDDLEWARE)
// Tudo que estiver ABAIXO desta linha exige token válido
// ==================================================================
app.use(authMiddleware); 

function getUTCMonthRange(mes) {
    let anoNum;
    let mesNum;
    if (mes) {
        const [ano, mesStr] = String(mes).split('-');
        anoNum = parseInt(ano);
        mesNum = parseInt(mesStr);
    } else {
        const now = new Date();
        anoNum = now.getUTCFullYear();
        mesNum = now.getUTCMonth() + 1;
    }

    if (!Number.isFinite(anoNum) || !Number.isFinite(mesNum) || mesNum < 1 || mesNum > 12) {
        return null;
    }

    const dataInicio = new Date(Date.UTC(anoNum, mesNum - 1, 1, 0, 0, 0)).toISOString();
    const dataFim = new Date(Date.UTC(anoNum, mesNum, 1, 0, 0, 0)).toISOString();
    return { dataInicio, dataFim };
}

function getUTCDayRange(yyyyMmDd) {
    const dia = yyyyMmDd || new Date().toISOString().slice(0, 10);
    const inicio = new Date(`${dia}T00:00:00.000Z`);
    const fim = new Date(`${dia}T00:00:00.000Z`);
    fim.setUTCDate(fim.getUTCDate() + 1);
    return { inicio: inicio.toISOString(), fim: fim.toISOString(), dia };
}


// ==================================================================
// 🔒 ÁREA SEGURA - SISTEMA COMPLETO
// ==================================================================

// --- ESTOQUE E HISTÓRICO ---

// Resumo Financeiro de Entradas (Mês)
app.get('/api/estoque/resumo', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const range = getUTCMonthRange(req.query && req.query.mes);
    if (!range) return res.status(400).json({ error: 'Mês inválido' });
    const { dataInicio, dataFim } = range;
    
    const { data, error } = await supabase
        .from('historico_estoque')
        .select('quantidade, preco_custo')
        .eq('tipo', 'ENTRADA')
        .gte('data_movimentacao', dataInicio)
        .lt('data_movimentacao', dataFim);

    if (error) return res.status(500).json({ error: error.message });

    const totalEntradasMes = data.reduce((acc, item) => acc + (item.quantidade * item.preco_custo), 0);
    res.json({ totalEntradasMes });
});

// Histórico Detalhado (Extrato)
app.get('/api/estoque/historico', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const range = getUTCMonthRange(req.query && req.query.mes);
    if (!range) return res.status(400).json({ error: 'Mês inválido' });
    const { dataInicio, dataFim } = range;
    
    const { data, error } = await supabase
        .from('historico_estoque')
        .select(`
            id, tipo, quantidade, preco_custo, data_movimentacao,
            produtos ( codigo, descricao )
        `)
        .eq('tipo', 'ENTRADA')
        .gte('data_movimentacao', dataInicio)
        .lt('data_movimentacao', dataFim)
        .order('data_movimentacao', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get('/api/dashboard/resumo', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const range = getUTCMonthRange(req.query && req.query.mes);
    if (!range) return res.status(400).json({ error: 'Mês inválido' });
    const { dataInicio, dataFim } = range;

    const hojeRange = getUTCDayRange();
    const inicioHoje = hojeRange.inicio;
    const fimHoje = hojeRange.fim;

    const seteDias = new Date(inicioHoje);
    seteDias.setUTCDate(seteDias.getUTCDate() + 7);
    const fimSeteDias = seteDias.toISOString();

    const atrasoOS = new Date(inicioHoje);
    atrasoOS.setUTCDate(atrasoOS.getUTCDate() - 7);
    const limiteOSAtrasada = atrasoOS.toISOString();

    const [
        fatMesRes,
        despesasMesRes,
        comprasRes,
        osAbertasRes,
        receberHojeRes,
        receberVencidoRes,
        receberProx7Res,
        osAbertasAtrasadasRes
    ] = await Promise.all([
        supabase.from('faturamentos').select('status, valor_parcela').gte('data_vencimento', dataInicio).lt('data_vencimento', dataFim),
        supabase.from('despesas').select('valor').gte('data_despesa', dataInicio).lt('data_despesa', dataFim),
        supabase.from('historico_estoque').select('quantidade, preco_custo').eq('tipo', 'ENTRADA').gte('data_movimentacao', dataInicio).lt('data_movimentacao', dataFim),
        supabase.from('ordens_servico').select('id').eq('status', 'ABERTA'),
        supabase.from('faturamentos').select('valor_parcela').eq('status', 'PENDENTE').gte('data_vencimento', inicioHoje).lt('data_vencimento', fimHoje),
        supabase.from('faturamentos').select('valor_parcela').neq('status', 'PAGO').lt('data_vencimento', inicioHoje),
        supabase.from('faturamentos').select('valor_parcela').neq('status', 'PAGO').gte('data_vencimento', inicioHoje).lt('data_vencimento', fimSeteDias),
        supabase.from('ordens_servico').select('id').eq('status', 'ABERTA').lt('data_abertura', limiteOSAtrasada)
    ]);

    const fatMes = fatMesRes.data || [];
    const despesasMes = despesasMesRes.data || [];
    const comprasMes = comprasRes.data || [];
    const osAbertas = osAbertasRes.data || [];
    const receberHoje = receberHojeRes.data || [];
    const receberVencido = receberVencidoRes.data || [];
    const receberProx7 = receberProx7Res.data || [];
    const osAbertasAtrasadas = osAbertasAtrasadasRes.data || [];

    if (fatMesRes.error) return res.status(500).json({ error: fatMesRes.error.message });
    if (despesasMesRes.error) return res.status(500).json({ error: despesasMesRes.error.message });
    if (comprasRes.error) return res.status(500).json({ error: comprasRes.error.message });
    if (osAbertasRes.error) return res.status(500).json({ error: osAbertasRes.error.message });
    if (receberHojeRes.error) return res.status(500).json({ error: receberHojeRes.error.message });
    if (receberVencidoRes.error) return res.status(500).json({ error: receberVencidoRes.error.message });
    if (receberProx7Res.error) return res.status(500).json({ error: receberProx7Res.error.message });
    if (osAbertasAtrasadasRes.error) return res.status(500).json({ error: osAbertasAtrasadasRes.error.message });

    const recebidoMes = fatMes.filter(f => String(f.status).toUpperCase() === 'PAGO').reduce((acc, f) => acc + Number(f.valor_parcela || 0), 0);
    const pendenteMes = fatMes.filter(f => String(f.status).toUpperCase() !== 'PAGO').reduce((acc, f) => acc + Number(f.valor_parcela || 0), 0);
    const despesasOperacionaisMes = despesasMes.reduce((acc, d) => acc + Number(d.valor || 0), 0);
    const comprasEstoqueMes = comprasMes.reduce((acc, item) => acc + (Number(item.quantidade || 0) * Number(item.preco_custo || 0)), 0);
    const lucroReal = recebidoMes - (despesasOperacionaisMes + comprasEstoqueMes);

    const aReceberHoje = receberHoje.reduce((acc, f) => acc + Number(f.valor_parcela || 0), 0);
    const aReceberVencido = receberVencido.reduce((acc, f) => acc + Number(f.valor_parcela || 0), 0);
    const aVencerProximos7Dias = receberProx7.reduce((acc, f) => acc + Number(f.valor_parcela || 0), 0);

    return res.json({
        mes: req.query && req.query.mes ? String(req.query.mes) : new Date().toISOString().slice(0, 7),
        recebidoMes,
        pendenteMes,
        despesasOperacionaisMes,
        comprasEstoqueMes,
        lucroReal,
        osAbertas: osAbertas.length,
        aReceberHoje,
        aReceberVencido,
        aVencerProximos7Dias,
        osAbertasAtrasadas: osAbertasAtrasadas.length
    });
});

// Listar Produtos
app.get('/api/produtos', async (req, res) => {
    const { data, error } = await supabase.from('produtos').select('*').order('descricao');
    if (error) return res.status(500).json({ error: error.message });
    const cargo = String(req.user && req.user.cargo || '').toUpperCase();
    if (cargo === 'FUNCIONARIO') {
        const formatado = data.map(p => ({
            id: p.id,
            codigo: p.codigo,
            descricao: p.descricao,
            marca: p.marca,
            qtdeAtual: p.qtde_atual,
            precoCusto: 0
        }));
        return res.json(formatado);
    }

    const formatado = data.map(p => ({
        id: p.id, codigo: p.codigo, descricao: p.descricao, marca: p.marca,
        qtdeAtual: p.qtde_atual, precoCusto: p.preco_custo, precoVenda: p.preco_venda
    }));
    return res.json(formatado);
});

// Busca por código para lançamento (FUNCIONARIO)
app.get('/api/produtos/codigo/:codigo/lancamento', requireCargo(['FUNCIONARIO']), async (req, res) => {
    const codigo = String(req.params.codigo || '').toUpperCase().trim();
    if (!codigo) return res.status(400).json({ error: 'Código inválido' });

    const { data: p, error } = await supabase
        .from('produtos')
        .select('id, codigo, descricao, marca, qtde_atual, preco_custo')
        .eq('codigo', codigo)
        .single();

    if (error || !p) return res.status(404).json({ error: 'Produto não encontrado' });

    const resposta = {
        id: p.id,
        codigo: p.codigo,
        descricao: p.descricao,
        marca: p.marca,
        qtdeAtual: p.qtde_atual
    };

    if (Number(p.qtde_atual) > 0) {
        return res.json({ ...resposta, precoCusto: p.preco_custo });
    }

    return res.json(resposta);
});

// Criar Produto (Com Registro de Histórico)
app.post('/api/produtos', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { codigo, descricao, marca, qtde, precoCusto, unidade } = req.body;
    
    // 1. Cria o produto
    const { data, error } = await supabase.from('produtos').insert([{
        codigo: codigo.toUpperCase(), descricao, marca, unidade: unidade || 'UN',
        qtde_atual: parseInt(qtde), preco_custo: parseFloat(precoCusto), preco_venda: 0
    }]).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // 2. Registra no histórico (se tiver qtde inicial)
    if (parseInt(qtde) > 0) {
        await supabase.from('historico_estoque').insert([{
            produto_id: data.id,
            tipo: 'ENTRADA',
            quantidade: parseInt(qtde),
            preco_custo: parseFloat(precoCusto)
        }]);
    }

    res.json(data);
});

// Atualizar Produto (Upsert / Entrada de Estoque)
app.put('/api/produtos/:id', async (req, res) => {
    const { id } = req.params;
    const { qtdeAtual, precoCusto, descricao, marca, qtdEntrada } = req.body;

    const cargo = String(req.user && req.user.cargo || '').toUpperCase();
    if (cargo === 'FUNCIONARIO') {
        const entrada = parseInt(qtdEntrada);
        if (!entrada || entrada <= 0) return res.status(400).json({ error: 'Entrada inválida' });

        const { data: atual, error: findError } = await supabase
            .from('produtos')
            .select('qtde_atual, preco_custo')
            .eq('id', id)
            .single();

        if (findError || !atual) return res.status(404).json({ error: 'Produto não encontrado' });

        const novaQtde = Number(atual.qtde_atual) + entrada;
        const custoAtual = Number(atual.preco_custo) || 0;

        const { data: updated, error: updateError } = await supabase
            .from('produtos')
            .update({ qtde_atual: novaQtde })
            .eq('id', id)
            .select();

        if (updateError) return res.status(500).json({ error: updateError.message });

        await supabase.from('historico_estoque').insert([{
            produto_id: id,
            tipo: 'ENTRADA',
            quantidade: entrada,
            preco_custo: custoAtual
        }]);

        return res.json(updated);
    }

    const { data, error } = await supabase
        .from('produtos')
        .update({ 
            qtde_atual: parseInt(qtdeAtual), 
            preco_custo: parseFloat(precoCusto),
            descricao: descricao,
            marca: marca
        })
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });

    if (qtdEntrada && parseInt(qtdEntrada) > 0) {
        await supabase.from('historico_estoque').insert([{
            produto_id: id,
            tipo: 'ENTRADA',
            quantidade: parseInt(qtdEntrada),
            preco_custo: parseFloat(precoCusto)
        }]);
    }

    return res.json(data);
});

// Excluir Produto (Com Desvínculo Seguro)
app.delete('/api/produtos/:id', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { id } = req.params;

    // 1. Desvincular das OS antigas (Preserva histórico visual, mas remove ID)
    const { error: updateError } = await supabase
        .from('itens_os')
        .update({ produto_id: null }) 
        .eq('produto_id', id);

    if (updateError) return res.status(500).json({ error: 'Erro ao desvincular histórico: ' + updateError.message });

    // 2. Apagar produto
    const { error } = await supabase.from('produtos').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    
    res.json({ message: 'Produto excluído e histórico preservado.' });
});


// --- DESPESAS ---
app.get('/api/despesas', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { data, error } = await supabase.from('despesas').select('*').order('data_despesa', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/despesas', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { dataDespesa, numeroNf, tipoNf, valor, fornecedor, departamento, observacoes } = req.body;
    const { data, error } = await supabase.from('despesas').insert([{
        data_despesa: dataDespesa, numero_nf: numeroNf, tipo_nf: tipoNf,
        valor: parseFloat(valor), fornecedor, departamento, observacoes
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
    app.delete('/api/despesas/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('despesas').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Despesa excluída com sucesso!' });
});
});


// --- CLIENTES E FATURAMENTO ---
app.get('/api/clientes', async (req, res) => {
    const cargo = String(req.user && req.user.cargo || '').toUpperCase();
    if (cargo === 'FUNCIONARIO') return res.status(403).json({ error: '🚫 Acesso negado' });
    const { data, error } = await supabase.from('clientes_empresas').select('*').order('nome_razao_social');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/clientes', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { nome, cnpj, telefone } = req.body;
    const { data, error } = await supabase.from('clientes_empresas').insert([{ 
        nome_razao_social: nome.toUpperCase(), cnpj_cpf: cnpj, telefone 
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get('/api/faturamentos', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { data, error } = await supabase.from('faturamentos')
        .select(`*, clientes_empresas ( nome_razao_social, cnpj_cpf )`)
        .order('data_vencimento');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/faturamentos/lancar', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { clienteId, valorTotal, qtdeParcelas, numeroDocumento, dataPrimeiroVencimento } = req.body;
    const parcelas = [];
    const valorParcela = parseFloat((valorTotal / qtdeParcelas).toFixed(2));
    let dataBase = new Date(dataPrimeiroVencimento + 'T12:00:00');

    for (let i = 1; i <= qtdeParcelas; i++) {
        let dataVenc = new Date(dataBase);
        dataVenc.setMonth(dataVenc.getMonth() + (i - 1));
        parcelas.push({
            cliente_id: clienteId, numero_documento: `${numeroDocumento}/${i}`,
            valor_parcela: valorParcela, numero_parcela: i, total_parcelas: qtdeParcelas,
            status: 'PENDENTE', data_lancamento: new Date(), data_vencimento: dataVenc
        });
    }
    const { data, error } = await supabase.from('faturamentos').insert(parcelas).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.put('/api/faturamentos/:id/pagar', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase.from('faturamentos').update({ status: 'PAGO' }).eq('id', id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});
// Excluir Faturamento
app.delete('/api/faturamentos/:id', async (req, res) => {
    const { id } = req.params;

    const { error } = await supabase
        .from('faturamentos')
        .delete()
        .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    
    res.json({ message: 'Faturamento excluído com sucesso!' });
});

// --- ORDENS DE SERVIÇO (OS) ---

app.get('/api/os', async (req, res) => {
    const cargo = String(req.user && req.user.cargo || '').toUpperCase();
    if (cargo === 'FUNCIONARIO') {
        const { data, error } = await supabase.from('ordens_servico')
            .select(`id, placa, veiculo, descricao_problema, status, data_abertura, clientes_empresas ( nome_razao_social )`)
            .eq('status', 'ABERTA')
            .order('id', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        return res.json(data);
    }

    const { data, error } = await supabase.from('ordens_servico')
        .select(`*, clientes_empresas ( nome_razao_social )`)
        .order('id', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

app.post('/api/os', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { clienteId, placa, veiculo, descricao } = req.body;
    const { data, error } = await supabase.from('ordens_servico').insert([{
        cliente_id: clienteId, placa: placa.toUpperCase(), veiculo, descricao_problema: descricao, status: 'ABERTA'
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get('/api/os/:id/itens', async (req, res) => {
    const cargo = String(req.user && req.user.cargo || '').toUpperCase();
    if (cargo === 'FUNCIONARIO') {
        const { data: os, error: osError } = await supabase
            .from('ordens_servico')
            .select('status')
            .eq('id', req.params.id)
            .single();

        if (osError || !os) return res.status(404).json({ error: 'OS não encontrada' });
        if (os.status !== 'ABERTA') return res.status(403).json({ error: '🚫 Acesso negado' });

        const { data, error } = await supabase
            .from('itens_os')
            .select('id, tipo, descricao, quantidade')
            .eq('os_id', req.params.id);

        if (error) return res.status(500).json({ error: error.message });
        return res.json(data);
    }

    const { data, error } = await supabase.from('itens_os').select('*').eq('os_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

app.post('/api/os/:id/itens', async (req, res) => {
    const cargo = String(req.user && req.user.cargo || '').toUpperCase();

    const osIdParam = parseInt(req.params.id);
    const osIdBody = req.body && req.body.osId !== undefined ? parseInt(req.body.osId) : osIdParam;
    if (!osIdParam || osIdBody !== osIdParam) return res.status(400).json({ error: 'OS inválida' });

    const tipo = String(req.body && req.body.tipo || '').toUpperCase();
    const produtoId = req.body && req.body.produtoId ? parseInt(req.body.produtoId) : null;
    const quantidadeNum = parseFloat(req.body && req.body.quantidade);

    if (!['PECA', 'SERVICO'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if (!Number.isFinite(quantidadeNum) || quantidadeNum <= 0) return res.status(400).json({ error: 'Quantidade inválida' });

    const { data: os, error: osError } = await supabase
        .from('ordens_servico')
        .select('status')
        .eq('id', osIdParam)
        .single();

    if (osError || !os) return res.status(404).json({ error: 'OS não encontrada' });
    if (os.status !== 'ABERTA') return res.status(403).json({ error: 'OS não está aberta' });

    let descricaoFinal = String(req.body && req.body.descricao || '').trim();
    let precoFinal = 0;

    if (tipo === 'PECA') {
        if (!produtoId) return res.status(400).json({ error: 'Produto inválido' });

        const { data: prod, error: prodError } = await supabase
            .from('produtos')
            .select('codigo, descricao, qtde_atual, preco_venda, preco_custo')
            .eq('id', produtoId)
            .single();

        if (prodError || !prod) return res.status(404).json({ error: 'Produto não encontrado' });

        if (!descricaoFinal) descricaoFinal = `${String(prod.codigo || '').toUpperCase()} - ${prod.descricao || ''}`.trim();

        const estoqueAtual = Number(prod.qtde_atual) || 0;
        if (quantidadeNum > estoqueAtual) return res.status(400).json({ error: 'Estoque insuficiente' });

        const precoVenda = Number(prod.preco_venda);
        const precoCusto = Number(prod.preco_custo);
        const precoBody = parseFloat(req.body && req.body.preco);

        if (cargo === 'FUNCIONARIO') {
            precoFinal = Number.isFinite(precoVenda) && precoVenda > 0 ? precoVenda : (Number.isFinite(precoCusto) ? precoCusto : 0);
        } else {
            if (Number.isFinite(precoBody)) {
                precoFinal = precoBody;
            } else {
                precoFinal = Number.isFinite(precoVenda) && precoVenda > 0 ? precoVenda : (Number.isFinite(precoCusto) ? precoCusto : 0);
            }
        }

        await supabase
            .from('produtos')
            .update({ qtde_atual: estoqueAtual - quantidadeNum })
            .eq('id', produtoId);
    }

    if (tipo === 'SERVICO') {
        if (!descricaoFinal) return res.status(400).json({ error: 'Descrição obrigatória' });

        if (cargo === 'FUNCIONARIO') {
            precoFinal = 0;
        } else {
            const precoBody = parseFloat(req.body && req.body.preco);
            if (!Number.isFinite(precoBody) || precoBody < 0) return res.status(400).json({ error: 'Preço inválido' });
            precoFinal = precoBody;
        }
    }

    const subtotal = quantidadeNum * precoFinal;

    const { data, error } = await supabase.from('itens_os').insert([{
        os_id: osIdParam,
        produto_id: tipo === 'PECA' ? produtoId : null,
        descricao: descricaoFinal,
        tipo,
        quantidade: quantidadeNum,
        preco_un: precoFinal,
        subtotal
    }]).select();

    const { data: itens } = await supabase.from('itens_os').select('subtotal').eq('os_id', osIdParam);
    const novoTotal = itens ? itens.reduce((acc, item) => acc + Number(item.subtotal || 0), 0) : 0;
    await supabase.from('ordens_servico').update({ total: novoTotal }).eq('id', osIdParam);

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

// Remover Item da OS (Com Estorno de Estoque)
app.delete('/api/os/itens/:id', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { id } = req.params;

    // 1. Busca info do item
    const { data: item, error: findError } = await supabase.from('itens_os').select('*').eq('id', id).single();
    if (findError) return res.status(500).json({ error: findError.message });

    // 2. Se for PEÇA, DEVOLVE ao estoque
    if (item.tipo === 'PECA' && item.produto_id) {
        const { data: prod } = await supabase.from('produtos').select('qtde_atual').eq('id', item.produto_id).single();
        if (prod) {
             await supabase.from('produtos').update({ qtde_atual: prod.qtde_atual + item.quantidade }).eq('id', item.produto_id);
        }
    }

    // 3. Deleta o item
    const { error: deleteError } = await supabase.from('itens_os').delete().eq('id', id);
    if (deleteError) return res.status(500).json({ error: deleteError.message });

    // 4. Recalcula Total da OS
    const { data: itens } = await supabase.from('itens_os').select('subtotal').eq('os_id', item.os_id);
    const novoTotal = itens ? itens.reduce((acc, i) => acc + i.subtotal, 0) : 0;
    await supabase.from('ordens_servico').update({ total: novoTotal }).eq('id', item.os_id);

    res.json({ message: 'Item removido e estoque estornado' });
});

app.put('/api/os/:id/finalizar', denyCargo(['FUNCIONARIO']), async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
        .from('ordens_servico')
        .update({ status: 'FINALIZADA', data_fechamento: new Date() })
        .eq('id', id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});


// ==================================================================
// --- GESTÃO DE USUÁRIOS ---
// ==================================================================

// Listar todos os usuários (sem mostrar a senha por segurança visual)
app.get('/api/usuarios', requireCargo(['ADMIN']), async (req, res) => {
    const { data, error } = await supabase
        .from('usuarios')
        .select('id, nome, cargo')
        .order('nome');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Criar novo usuário (AGORA COM CONFIRMAÇÃO DE SENHA)
app.post('/api/usuarios', requireCargo(['ADMIN']), async (req, res) => {
    const { nome, senha, confirmarSenha, cargo } = req.body; // Recebe confirmarSenha

    // 1. Validação de senha
    if (senha !== confirmarSenha) {
        return res.status(400).json({ error: 'As senhas não coincidem!' });
    }

    // 2. Verifica se usuário já existe
    const { data: existe } = await supabase
        .from('usuarios')
        .select('id')
        .eq('nome', nome)
        .single();

    if (existe) {
        return res.status(400).json({ error: 'Usuário já existe!' });
    }

    // 3. Salva no banco (Agora salvando o Cargo também)
    const { data, error } = await supabase
        .from('usuarios')
        .insert([{ 
            nome, 
            senha, 
            cargo: cargo || 'FUNCIONARIO' 
        }])
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Alterar Senha (AGORA COM CONFIRMAÇÃO)
app.put('/api/usuarios/:id', requireCargo(['ADMIN']), async (req, res) => {
    const { id } = req.params;
    const { novaSenha, confirmarSenha } = req.body; // Recebe confirmarSenha

    // 1. Validação
    if (novaSenha !== confirmarSenha) {
        return res.status(400).json({ error: 'As senhas não coincidem!' });
    }

    // 2. Atualiza no banco
    const { data, error } = await supabase
        .from('usuarios')
        .update({ senha: novaSenha })
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Excluir Usuário
app.delete('/api/usuarios/:id', requireCargo(['ADMIN']), async (req, res) => {
    const { id } = req.params;

    // Proteção: Não deixar excluir a si mesmo
    if (req.user && req.user.id == id) {
        return res.status(400).json({ error: 'Você não pode excluir seu próprio usuário!' });
    }

    const { error } = await supabase.from('usuarios').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    
    res.json({ message: 'Usuário removido com sucesso.' });
});

// --- CONFIGURAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 8080;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Backend completo e protegido rodando na porta ${PORT}`);
    });
}

module.exports = app;
//npx nodemon server.js

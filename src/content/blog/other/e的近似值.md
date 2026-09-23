---
"title": "e的近似值"
"slug": "other/e的近似值"
"pubDate": "2026-01-29T13:21:00+08:00"
"updatedDate": "2026-01-29T14:51:00+08:00"
"categories":
  - "数学"
"tags": []
---

## e的近似值

$$
e \approx \frac{271801}{99990}, \quad \text{精确到小数点后9位}
$$

$$
e \approx (\pi^4 + \pi^5)^{1/6}, \quad \text{精确到小数点后7位}
$$

[Is this the Coolest Approximation for e?](https://www.youtube.com/watch?v=jyjFTUONiqc) 提到了一种用到了 123456789 的近似

$$
e \approx (1+9^{-4^{6 \times 7}})^{3^{2^{85}}}, \quad \text{精确到小数点后18457734525360901453873570位}
$$

从 $e$ 的定义出发

$$
e = \lim_{n\to\infty} \left(1+\frac{1}{n}\right)^n
$$

上面近似中的大数字

$$
9^{4^{6 \times 7}} = 9^{4^{42}} = (3^2)^{(2^2)^{42}} = 3^{2^{85}}
$$

确实满足 $e$ 的定义式，近似很有道理，但是我想知道如何得到近似的精度。

## 判断这个数字精确到 $e$ 的小数点后几位

$$
A = \left(1+\frac{1}{N}\right)^N
$$

$$
\begin{align}
\ln A &= N \ln \left( 1 + \frac{1}{N} \right) \\
&= N \left( \frac{1}{N} - \frac{1}{2 N^2} + \frac{1}{3 N^3} - \cdots \right) \\
&= 1 - \frac{1}{2 N} + \frac{1}{3 N^2} - \cdots
\end{align}
$$

$$
A = e^{\ln A} = e^{1 - \frac{1}{2N} + O(\frac{1}{N^2})} = e^1 \cdot e^{-\frac{1}{2N}} \cdot e^{O(\frac{1}{N^2})}
$$

再次利用 $e^x \approx 1+x$ 的近似：

$$
A \approx e \left( 1 - \frac{1}{2N} \right) = e - \frac{e}{2N}
$$

该近似值的绝对误差大约是 $\frac{e}{2N}$。

要确定“精确到小数点后多少位”，我们主要看误差项 $\frac{1}{N}$ 的数量级。有效位数 $D$ 大约等于 $N$ 的以10为底的对数。

$$
D \approx \log_{10}(N)
$$

我们可以使用 Python 的 `decimal` 模块进行高精度计算：

```python
import decimal

# 设置精度，足以容纳计算过程
decimal.getcontext().prec = 100

power_of_2 = decimal.Decimal(2) ** 85
log10_3 = decimal.Decimal(3).log10()
total_digits = power_of_2 * log10_3

print(f"{total_digits:.0f}")
```

可以得到

```text
18457734525360901453873570
```

确实如此。

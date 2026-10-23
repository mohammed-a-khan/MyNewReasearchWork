package com.example.shop;

import org.junit.jupiter.api.*;
import org.openqa.selenium.*;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.support.ui.*;
import static org.junit.jupiter.api.Assertions.*;

public class LoginTest {
    private static final String BASE = "http://localhost:4600";
    private WebDriver driver;
    private WebDriverWait wait;

    @BeforeEach
    public void setUp() {
        driver = new ChromeDriver();
        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(5));
        wait = new WebDriverWait(driver, Duration.ofSeconds(10));
        driver.get(BASE + "/login");
    }

    @Test
    @Tag("smoke")
    public void loginAsBob() {
        driver.findElement(By.id("username")).sendKeys("bob");
        WebElement password = driver.findElement(By.name("password"));
        password.clear();
        password.sendKeys("Builder#2", Keys.ENTER);
        wait.until(ExpectedConditions.urlContains("/dashboard"));
        assertEquals("bob", driver.findElement(By.cssSelector("[data-testid='welcome-user']")).getText());
        assertTrue(driver.getTitle().contains("Dashboard"));
    }

    @Test
    public void createOrder() throws Exception {
        driver.findElement(By.linkText("New order")).click();
        new Select(driver.findElement(By.id("product"))).selectByVisibleText("Gadget (49.50)");
        Select customer = new Select(driver.findElement(By.id("customer")));
        customer.selectByIndex(2);
        driver.findElement(By.xpath("//button[@type='submit']")).click();
        Thread.sleep(500);
        assertTrue(driver.findElement(By.className("toast")).isDisplayed());
        String orderNo = driver.findElement(By.cssSelector("[data-testid=order-number]")).getText();
        for (int i = 0; i < 3; i++) { System.out.println(i); }
        ((JavascriptExecutor) driver).executeScript("window.scrollTo(0, 0)");
    }

    @AfterEach
    public void tearDown() {
        driver.quit();
    }
}
